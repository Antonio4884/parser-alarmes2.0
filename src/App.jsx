import React, { useState } from 'react';

// ═════════════════════════════════════════════════════════
// MÓDULO: CONVENCIONAL / METRO
// ═════════════════════════════════════════════════════════

function converterHorario24h(horario12h) {
  const horarioMatch = horario12h.match(/(\d{1,2}):(\d{2}):(\d{2})\s?(AM|PM)/i);
  if (!horarioMatch) return null;
  let [, hora, minuto, segundo, periodo] = horarioMatch;
  hora = parseInt(hora, 10);
  if (periodo.toUpperCase() === 'PM' && hora !== 12) hora += 12;
  if (periodo.toUpperCase() === 'AM' && hora === 12) hora = 0;
  return `${hora.toString().padStart(2, '0')}:${minuto}:${segundo}`;
}

function horarioParaSegundos(horario) {
  const [h, m, s] = horario.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function extrairDadosConvencional(linha) {
  const horarioMatch = linha.match(/(\d{1,2}:\d{2}:\d{2}\s?(AM|PM))/i);
  const horarioOriginal = horarioMatch ? horarioMatch[1] : null;
  const horario = horarioOriginal ? converterHorario24h(horarioOriginal) : null;

  const hostMatch = linha.match(/\s([a-zA-Z0-9\-]+)\s+Interface/);
  if (!hostMatch) return null;
  const host = hostMatch[1];

  const intfMatch = linha.match(/Interface\s+([^(]+)\(/);
  if (!intfMatch) return null;
  const interfaceName = intfMatch[1].trim();

  let cli = 'UNKNOWN';
  const cliMatch = linha.match(/CLI:\s*([^\s#\)]+)/);
  if (cliMatch) cli = cliMatch[1];

  return { host, interfaceName, cli, horario };
}

function ordenarInterfaceConvencional(interfaceName) {
  const numeros = interfaceName.match(/(\d+)\/(\d+)(?:\/(\d+))?/);
  if (!numeros) return Number.MAX_SAFE_INTEGER;
  const a = parseInt(numeros[1] || 0, 10);
  const b = parseInt(numeros[2] || 0, 10);
  const c = parseInt(numeros[3] || 0, 10);
  return a * 100000 + b * 100 + c;
}

function verificarDiferencaHorarios(lista) {
  if (lista.length <= 1) return [];
  const base = horarioParaSegundos(lista[0].horario);
  return lista.filter((item) => Math.abs(horarioParaSegundos(item.horario) - base) >= 1800);
}

function processarAlarmes(texto) {
  const dados = {};
  const hosts = new Set();
  const todasInterfaces = [];

  texto.split('\n').forEach((linha) => {
    const resultado = extrairDadosConvencional(linha.trim());
    if (!resultado) return;
    const { host, interfaceName, cli, horario } = resultado;
    hosts.add(host);
    todasInterfaces.push(resultado);
    if (!dados[host]) dados[host] = [];
    dados[host].push({ interfaceName, cli, horario });
  });

  if (Object.keys(dados).length === 0) return 'Nenhum alarme válido encontrado.';

  const equipamentos = Array.from(hosts).sort().join(', ');
  const horarioPrincipal = todasInterfaces[0]?.horario || '--:--:--';

  let saida = `-:CARIMBO DE ABERTURA - NOC:-.
Falha: Indisponibilidade em rede convencional/metro
Equipamento:
${equipamentos}
Alarme: loss
Data/Hora: ${horarioPrincipal} BRT
IP: XXXXXXXXXXXXXXX

Fone NOC 3318-7890

`;

  const divergentes = verificarDiferencaHorarios(todasInterfaces);
  if (divergentes.length > 0) {
    saida += `⚠ INTERFACES COM HORÁRIOS DIFERENTES (>30 MIN)\n`;
    divergentes.forEach((item) => {
      saida += `${item.interfaceName} - ${item.horario}\n`;
    });
    saida += '\n';
  }

  Object.keys(dados).sort().forEach((host) => {
    saida += `${host}\n`;
    dados[host]
      .sort((a, b) => ordenarInterfaceConvencional(a.interfaceName) - ordenarInterfaceConvencional(b.interfaceName))
      .forEach(({ interfaceName, cli }) => {
        saida += `${interfaceName} CLI:${cli}\n`;
      });
    saida += '\n';
  });

  return saida.trim();
}

// ═════════════════════════════════════════════════════════
// MÓDULO: ÓPTICA / PON
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// DETECÇÃO DE GERÊNCIA
// ─────────────────────────────────────────────
function detectarGerencia(linhas) {
  for (const linha of linhas) {
    const l = linha.toLowerCase();

    // AMS5520 – Primária CSV (PON Port sem ONT na mesma linha)
    if (l.includes('pon port:') && l.includes('.lt') && l.includes('.pon') && !l.includes('.ont')) {
      return 'PRIMARIA_CSV';
    }

    // AMS5520 – Secundária (ONT: com .lt e .pon e .ont)
    if (l.includes('ont:') && l.includes('.lt') && l.includes('.pon') && l.includes('.ont')) {
      return 'AMS';
    }

    // AMS5520 – SFP
    if (l.includes('ethernet lt port:')) return 'AMS_SFP';

    // iMaster – Primária (feeder fiber)
    if (l.includes('the feeder fiber is broken')) return 'IMASTER_PRIMARIA';

    // iMaster – Secundária (distribute fiber ou ONUID)
    if (l.includes('the distribute fiber is broken') || l.includes('onuid=')) {
      return 'IMASTER';
    }

    // ZTE
    if (l.includes('c600') || l.includes('rack=')) return 'ZTE';

    // UNM2000 – tem tabulações e padrão /GC ou /PON
    if (
      linha.includes('\t') &&
      (l.includes('off line') || l.includes('link_loss') || l.includes('link loss')) &&
      (l.includes('/gc') || l.includes('/pon'))
    ) {
      return 'UNM2000';
    }
  }

  return 'IMASTER';
}

// ─────────────────────────────────────────────
// EXTRATORES AMS5520
// ─────────────────────────────────────────────

function extrairPrimariaCsv(linhas) {
  const interfaces = [];
  let olt = '';

  linhas.forEach((linha) => {
    const match = linha.match(/PON Port:([^:,\s]+):([^,\s]+)/i);
    if (!match) return;

    const nomeOlt = match[1]; // "OLTCTA22"
    const caminho = match[2]; // "R1.S1.LT4.PON1"

    if (!olt) olt = nomeOlt;
    interfaces.push(`${nomeOlt}:${caminho}`);
  });

  if (!interfaces.length) return 'Nenhuma interface encontrada.';

  return `Indisponibilidade em rede HTT - sem afetação\nEquipamento: ${olt}\n\n${interfaces.join('\n')}`;
}

function extrairOntsAms(linhas) {
  const interfaces = [];
  let olt = '';

  linhas.forEach((linha) => {
    const match = linha.match(/ONT:([^:,\s]+):([^,\s]+)/i);
    if (!match) return;

    const nomeOlt = match[1]; // "OLTCTA21"
    const caminho = match[2]; // "R1.S1.LT16.PON1.ONT4"

    if (!olt) olt = nomeOlt;
    interfaces.push(`${nomeOlt}:${caminho}`);
  });

  if (!interfaces.length) return 'Nenhuma interface encontrada.';

  return `Indisponibilidade em rede HTT - Com afetação\nEquipamento: ${olt}\n\n${interfaces.join('\n')}\n\nHTT-afetados:`;
}

function extrairSfpAms(linhas) {
  const interfaces = [];
  let olt = '';

  linhas.forEach((linha) => {
    // Captura "Ethernet LT Port:OLTOCO21:R1.S1.LT16.P15,SFP"
    const match = linha.match(/Ethernet LT Port:([^:,\s]+):([^,\s]+,SFP)/i);
    if (!match) return;

    const nomeOlt = match[1]; // "OLTOCO21"
    const caminho = match[2]; // "R1.S1.LT16.P15,SFP"

    if (!olt) olt = nomeOlt;
    interfaces.push(`${nomeOlt}:${caminho} -`);
  });

  if (!interfaces.length) return 'Nenhuma interface encontrada.';

  return `Indisponibilidade em rede HTT\nEquipamento: ${olt}\n\n${interfaces.join('\n')}\n\nHTT-afetados`;
}

// ─────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────
function formatarCliente(onu, contrato) {
  return `ONU ${String(onu).padEnd(4, ' ')} - ${contrato}`;
}

// Ordena interfaces no formato "slot/port" numericamente
function ordenarInterfaces(lista) {
  return [...new Set(lista)].sort((a, b) => {
    const partsA = a.split('/').map((p) => parseInt(p) || 0);
    const partsB = b.split('/').map((p) => parseInt(p) || 0);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

// ─────────────────────────────────────────────
// GERAÇÃO DE TICKETS
// ─────────────────────────────────────────────
function gerarTicketsTexto(gerencia, linhas) {
  let resultadoFinal = '';

  // ── iMaster PRIMÁRIA ──────────────────────────────────────
  if (gerencia === 'IMASTER_PRIMARIA') {
    let olt = '';
    let interfaces = [];
    let totalCircuitos = 0;

    linhas.forEach((linha) => {
      // Nome da OLT: ex "olt5-bte-se" – captura padrão "olt\w+-\w+-\w+"
      const oltMatch = linha.match(/\b(olt[\w-]+)\b/i);
      const slotMatch = linha.match(/Slot=(\d+)/i);
      const portMatch = linha.match(/Port=(\d+)/i);
      const totalMatch = linha.match(/The number of affected ONTs=(\d+)/i);

      if (oltMatch && !olt) olt = oltMatch[1];
      if (totalMatch) totalCircuitos += Number(totalMatch[1]);

      // Só adiciona interface se tiver slot E port válidos
      if (slotMatch && portMatch) {
        interfaces.push(`${slotMatch[1]}/${portMatch[1]}`);
      }
    });

    interfaces = ordenarInterfaces(interfaces);

    resultadoFinal += `-:CARIMBO DE ABERTURA - NOC:-.
Falha: - Falha em rede Primaria, OLT: ${olt} - Circuitos afetados: ${totalCircuitos}
Equipamento: OLT: ${olt}
Data/Hora:
Interface: ${interfaces.join(', ')}
Circuitos afetados: ${totalCircuitos}

Fone NOC 3318-7890

`;

    interfaces.forEach((item) => {
      const partes = item.split('/');
      resultadoFinal += `Slot:${partes[0]}/Port:${partes[1]}\n`;
    });

    return resultadoFinal.trim();
  }

  // ── iMaster SECUNDÁRIA ────────────────────────────────────
  if (gerencia === 'IMASTER') {
    const agrupado = {};
    let olt = '';
    let totalCircuitos = 0;

    linhas.forEach((linha) => {
      const oltMatch = linha.match(/\b(olt[\w-]+)\b/i);
      const slotMatch = linha.match(/Slot=(\d+)/i);
      const portMatch = linha.match(/Port=(\d+)/i);
      const onuMatch = linha.match(/ONUID=(\d+)/i);

      // Contrato: prioriza "Description of the ONT(only for NMS)=NUMERO"
      const contratoMatch = linha.match(/Description of the ONT\(only for NMS\)=(\d+)/i);

      if (!slotMatch || !portMatch || !onuMatch) return;

      const oltNome = oltMatch ? oltMatch[1] : olt;
      const slot = slotMatch[1];
      const port = portMatch[1];
      const onu = onuMatch[1];
      const contrato = contratoMatch ? contratoMatch[1] : 'NCE';

      if (!olt && oltNome) olt = oltNome;
      totalCircuitos++;

      const chave = `${oltNome}-${slot}-${port}`;

      if (!agrupado[chave]) {
        agrupado[chave] = { olt: oltNome, slot, port, clientes: [] };
      }

      agrupado[chave].clientes.push({ onu, contrato });
    });

    resultadoFinal += `-:CARIMBO DE ABERTURA - NOC:-.
Falha em rede Secundaria OLT: ${olt} - circuitos afetados: ${totalCircuitos}
Equipamento: ${olt}
Alarme: LOSi/LOBi
Data/Hora:


`;

    Object.values(agrupado).forEach((grupo) => {
      resultadoFinal += `${grupo.olt} - ${grupo.slot}/${grupo.port}\n`;

      grupo.clientes
        .sort((a, b) => Number(a.onu) - Number(b.onu))
        .forEach((cliente) => {
          resultadoFinal += `${formatarCliente(cliente.onu, cliente.contrato)}\n`;
        });

      resultadoFinal += '\n';
    });

    return resultadoFinal.trim();
  }

  // ── UNM2000 ───────────────────────────────────────────────
  if (gerencia === 'UNM2000') {
    let olt = '';
    const interfacesPrimaria = [];   // ex: "GC8B[1]/PON3"
    const clientesSecundaria = [];   // ex: { interface, nome, id }

    linhas.forEach((linha) => {
      if (!linha.includes('\t')) return;
      const cols = linha.split('\t');

      // OLT: 7ª coluna (índice 6) — ex: "LEO-01" ou "SAN-02"
      if (!olt && cols[6] && cols[6].trim()) {
        olt = cols[6].trim();
      }

      // Coluna de interface: 8ª coluna (índice 7)
      // Formato primária: "LEO-01/GC8B[1]/PON3"
      // Formato secundária: "SAN-02/GC8B[3]/PON5/9825274_1554157_UBS_SANTIAGO:[16]"
      const colunaInterface = cols[7] ? cols[7].trim() : '';

      // Extrai a parte da interface (até /PON\d+)
      const ifMatch = colunaInterface.match(/([A-Z0-9-]+\/GC[\w\[\]]+\/PON\d+)/i);
      if (!ifMatch) return;

      const interfaceBase = ifMatch[1]; // "LEO-01/GC8B[1]/PON3" ou "SAN-02/GC8B[3]/PON5"

      // Verifica se é secundária (tem algo após /PON\d+)
      const secundariaMatch = colunaInterface.match(
        /[A-Z0-9-]+\/GC[\w\[\]]+\/PON\d+\/(.+)/i
      );

      if (secundariaMatch) {
        // Secundária — captura nome do cliente e ID entre colchetes
        const clienteRaw = secundariaMatch[1]; // "9825274_1554157_UBS_SANTIAGO:[16]"
        const idMatch = clienteRaw.match(/:?\[(\d+)\]/);
        const nomeMatch = clienteRaw.match(/^(\d+)/);

        clientesSecundaria.push({
          interface: interfaceBase,
          contrato: nomeMatch ? nomeMatch[1] : clienteRaw,
          onu: idMatch ? idMatch[1] : '?',
        });
      } else {
        // Primária — apenas interface
        interfacesPrimaria.push(interfaceBase);
      }
    });

    // ── UNM2000 Primária
    if (interfacesPrimaria.length > 0) {
      const ifOrdenadas = ordenarInterfaces(interfacesPrimaria);

      resultadoFinal += `-:CARIMBO DE ABERTURA - NOC:-.
Falha: Falha em rede Primaria, OLT: ${olt}
Equipamento: ${olt}
Data/Hora:
Interface:
${ifOrdenadas.join('\n')}

Circuitos afetados: 

Fone NOC 3318-7890`;
    }

    // ── UNM2000 Secundária
    if (clientesSecundaria.length > 0) {
      if (resultadoFinal) resultadoFinal += '\n\n';

      // Agrupar por interface
      const agrupado = {};
      clientesSecundaria.forEach(({ interface: iface, contrato, onu }) => {
        if (!agrupado[iface]) agrupado[iface] = [];
        agrupado[iface].push({ contrato, onu });
      });

      resultadoFinal += `-:CARIMBO DE ABERTURA - NOC:-.
Falha em rede Secundaria OLT: ${olt} - circuitos afetados: ${clientesSecundaria.length}
Equipamento: ${olt}
Alarme: LINK_LOSS
Data/Hora:

`;

      Object.entries(agrupado).forEach(([iface, clientes]) => {
        resultadoFinal += `${iface}\n`;
        clientes
          .sort((a, b) => Number(a.onu) - Number(b.onu))
          .forEach(({ onu, contrato }) => {
            resultadoFinal += `${formatarCliente(onu, contrato)}\n`;
          });
        resultadoFinal += '\n';
      });
    }

    return resultadoFinal.trim();
  }

  // ── ZTE ──────────────────────────────────────────────────
  if (gerencia === 'ZTE') {
    let olt = '';
    const interfacesPrimaria = [];
    const agrupado = {};
    let totalSecundaria = 0;

    linhas.forEach((linha) => {
      // OLT: ex "olt4-nprfzr01"
      const oltMatch = linha.match(/\b(olt[\w-]+)\b/i);
      if (oltMatch && !olt) olt = oltMatch[1];

      const rackMatch = linha.match(/RACK=(\d+)/i);
      const slotMatch = linha.match(/SLOT=(\d+)/i);
      const portMatch = linha.match(/PORT=(\d+)/i);
      const onuMatch = linha.match(/,ONU=(\d+)/i);

      // Interface completa via "Port=gpon_olt-RACK/SLOT/PORT"
      const gponMatch = linha.match(/Port=gpon_olt-([\d/]+)/i);

      // Contrato/nome da ONU: "ONU Name=2878622"
      const onuNameMatch = linha.match(/ONU Name=(\d+)/i);

      if (!slotMatch || !portMatch) return;

      const rack = rackMatch ? rackMatch[1] : '1';
      const slot = slotMatch[1];
      const port = portMatch[1];
      // Usa a interface do campo gpon_olt se disponível, senão monta RACK/SLOT/PORT
      const interfaceCompleta = gponMatch ? gponMatch[1] : `${rack}/${slot}/${port}`;

      if (onuMatch) {
        // Secundária
        const onu = onuMatch[1];
        const contrato = onuNameMatch ? onuNameMatch[1] : 'NCE';
        const chave = `${slot}/${port}`;

        if (!agrupado[chave]) agrupado[chave] = [];
        agrupado[chave].push({ onu, contrato });
        totalSecundaria++;
      } else {
        // Primária
        interfacesPrimaria.push(interfaceCompleta);
      }
    });

    // ── ZTE Primária
    if (interfacesPrimaria.length > 0) {
      const ifOrdenadas = ordenarInterfaces(interfacesPrimaria);

      resultadoFinal += `-:CARIMBO DE ABERTURA - NOC:-.
Falha em rede Primaria NOVA -  ${olt} - ${ifOrdenadas.join(', ')} - Circuitos afetados: 
OLT: ${olt}
Interface: ${ifOrdenadas.join(', ')}
Data/Hora:
Fone NOC 3318-7890`;
    }

    // ── ZTE Secundária
    if (Object.keys(agrupado).length > 0) {
      if (resultadoFinal) resultadoFinal += '\n\n';

      resultadoFinal += `-:CARIMBO DE ABERTURA - NOC:-.
Falha em rede Secundaria ZTE OLT: ${olt} - circuitos afetados: ${totalSecundaria}
Equipamento: ${olt}
Alarme: ONU LOS
Data/Hora:

`;

      Object.entries(agrupado).forEach(([iface, clientes]) => {
        resultadoFinal += `${olt} - ${iface}\n`;
        clientes
          .sort((a, b) => Number(a.onu) - Number(b.onu))
          .forEach(({ onu, contrato }) => {
            resultadoFinal += `${formatarCliente(onu, contrato)}\n`;
          });
        resultadoFinal += '\n';
      });
    }

    return resultadoFinal.trim();
  }

  return 'Nenhum alarme reconhecido.';
}

// ─────────────────────────────────────────────
// PROCESSADOR PRINCIPAL
// ─────────────────────────────────────────────
function processarTexto(texto) {
  const linhas = texto.split('\n').filter(Boolean);
  const gerencia = detectarGerencia(linhas);

  if (gerencia === 'AMS') return extrairOntsAms(linhas);
  if (gerencia === 'AMS_SFP') return extrairSfpAms(linhas);
  if (gerencia === 'PRIMARIA_CSV') return extrairPrimariaCsv(linhas);

  return gerarTicketsTexto(gerencia, linhas);
}

// ─────────────────────────────────────────────
// COMPONENTE REACT — VISUAL PREMIUM
// ─────────────────────────────────────────────

const FIBRAS = Array.from({ length: 18 }, (_, i) => ({
  id: i,
  x: Math.random() * 100,
  dur: 6 + Math.random() * 8,
  delay: Math.random() * 6,
  width: 0.8 + Math.random() * 1.4,
  opacity: 0.12 + Math.random() * 0.22,
  curve: (Math.random() - 0.5) * 40,
}));

function useGlobalReset() {
  React.useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body, #root { width: 100%; min-height: 100vh; background: #06080f; }
      body { overflow-x: hidden; }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);
}

function FiberBackground() {
  return (
    <svg
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}
      preserveAspectRatio="none"
    >
      <defs>
        {FIBRAS.map((f) => (
          <linearGradient key={f.id} id={`fg${f.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00d4ff" stopOpacity="0" />
            <stop offset="40%" stopColor="#00d4ff" stopOpacity={f.opacity * 1.6} />
            <stop offset="60%" stopColor="#7c3aed" stopOpacity={f.opacity} />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {FIBRAS.map((f) => (
        <line
          key={f.id}
          x1={`${f.x}%`} y1="-5%"
          x2={`${f.x + f.curve * 0.1}%`} y2="105%"
          stroke={`url(#fg${f.id})`}
          strokeWidth={f.width}
          style={{
            animation: `fiberPulse ${f.dur}s ${f.delay}s ease-in-out infinite alternate`,
          }}
        />
      ))}
      <style>{`
        @keyframes fiberPulse {
          0%   { opacity: 0.2; transform: translateX(0px); }
          50%  { opacity: 1;   transform: translateX(3px); }
          100% { opacity: 0.3; transform: translateX(-2px); }
        }
      `}</style>
    </svg>
  );
}

const LABEL_GERENCIA = {
  IMASTER_PRIMARIA: 'iMaster — Primária',
  IMASTER:          'iMaster — Secundária',
  UNM2000:          'UNM2000',
  ZTE:              'ZTE',
  AMS:              'AMS5520 — Secundária',
  AMS_SFP:          'AMS5520 — SFP',
  PRIMARIA_CSV:     'AMS5520 — Primária',
};

const ICON_GERENCIA = {
  IMASTER_PRIMARIA: '📡',
  IMASTER:          '📡',
  UNM2000:          '🖥',
  ZTE:              '⚙',
  AMS:              '📋',
  AMS_SFP:          '📋',
  PRIMARIA_CSV:     '📋',
};

export default function App() {
  useGlobalReset();
  const [aba, setAba] = useState('optica');

  const [entradaOptica, setEntradaOptica]       = useState('');
  const [resultadoOptica, setResultadoOptica]   = useState('');
  const [gerencia, setGerencia]                 = useState('');
  const [copiadoOptica, setCopiadoOptica]       = useState(false);

  const [entradaConv, setEntradaConv]           = useState('');
  const [resultadoConv, setResultadoConv]       = useState('');
  const [copiadoConv, setCopiadoConv]           = useState(false);

  const handleGerarOptica = () => {
    const linhas = entradaOptica.split('\n').filter(Boolean);
    const g = detectarGerencia(linhas);
    setGerencia(g);
    setResultadoOptica(processarTexto(entradaOptica));
    setCopiadoOptica(false);
  };
  const handleCopiarOptica = () => {
    if (!resultadoOptica) return;
    navigator.clipboard.writeText(resultadoOptica).then(() => {
      setCopiadoOptica(true);
      setTimeout(() => setCopiadoOptica(false), 2000);
    });
  };
  const handleLimparOptica = () => { setEntradaOptica(''); setResultadoOptica(''); setGerencia(''); };

  const handleGerarConv = () => {
    setResultadoConv(processarAlarmes(entradaConv));
    setCopiadoConv(false);
  };
  const handleCopiarConv = () => {
    if (!resultadoConv) return;
    navigator.clipboard.writeText(resultadoConv).then(() => {
      setCopiadoConv(true);
      setTimeout(() => setCopiadoConv(false), 2000);
    });
  };
  const handleLimparConv = () => { setEntradaConv(''); setResultadoConv(''); };

  const s = {
    wrap: {
      position: 'relative',
      minHeight: '100vh',
      width: '100vw',
      background: '#06080f',
      color: '#e2eaf4',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
    },
    inner: {
      position: 'relative',
      zIndex: 1,
      width: '100%',
      maxWidth: '100%',
      padding: '36px 48px 90px',
      flex: 1,
      boxSizing: 'border-box',
    },
    header: {
      marginBottom: '32px',
    },
    title: {
      fontSize: '28px',
      fontWeight: '700',
      letterSpacing: '0.08em',
      color: '#e2eaf4',
      margin: '0 0 6px',
      textTransform: 'uppercase',
    },
    titleAccent: {
      color: '#00d4ff',
    },
    subtitle: {
      fontSize: '13px',
      color: '#4a6080',
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      margin: 0,
    },
    tabBar: {
      display: 'flex',
      gap: '4px',
      marginBottom: '28px',
      borderBottom: '1px solid #0f1e30',
      paddingBottom: '0',
    },
    tab: (ativo) => ({
      padding: '12px 28px',
      fontSize: '15px',
      fontFamily: 'inherit',
      fontWeight: ativo ? '700' : '400',
      letterSpacing: '0.05em',
      background: ativo ? 'rgba(0,212,255,0.08)' : 'transparent',
      color: ativo ? '#00d4ff' : '#4a6080',
      border: 'none',
      borderBottom: ativo ? '2px solid #00d4ff' : '2px solid transparent',
      cursor: 'pointer',
      marginBottom: '-1px',
      transition: 'all 0.2s',
    }),
    label: {
      fontSize: '13px',
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: '#2a4a6a',
      marginBottom: '8px',
    },
    textarea: (cor) => ({
      width: '100%',
      padding: '16px 18px',
      background: 'rgba(255,255,255,0.03)',
      color: cor || '#c8d8e8',
      border: '1px solid #0f1e30',
      borderRadius: '8px',
      fontSize: '15px',
      fontFamily: 'inherit',
      resize: 'vertical',
      boxSizing: 'border-box',
      outline: 'none',
      lineHeight: '1.7',
      transition: 'border-color 0.2s',
    }),
    btnRow: {
      display: 'flex',
      gap: '12px',
      alignItems: 'center',
      margin: '16px 0',
      flexWrap: 'wrap',
    },
    btnPrimary: {
      padding: '12px 28px',
      background: 'linear-gradient(135deg, #0066aa, #00aacc)',
      color: '#fff',
      border: 'none',
      borderRadius: '8px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontWeight: '700',
      fontSize: '15px',
      letterSpacing: '0.06em',
      boxShadow: '0 0 16px rgba(0,180,230,0.25)',
      transition: 'all 0.2s',
    },
    btnSecondary: (ativo) => ({
      padding: '12px 22px',
      background: ativo ? 'rgba(0,200,80,0.12)' : 'rgba(255,255,255,0.04)',
      color: ativo ? '#00e676' : '#4a6080',
      border: `1px solid ${ativo ? '#00e676' : '#0f1e30'}`,
      borderRadius: '8px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: '15px',
      letterSpacing: '0.04em',
      transition: 'all 0.2s',
    }),
    btnGhost: {
      padding: '12px 20px',
      background: 'transparent',
      color: '#2a4a6a',
      border: '1px solid #0f1e30',
      borderRadius: '8px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: '15px',
      transition: 'all 0.2s',
    },
    badge: {
      marginLeft: 'auto',
      background: 'rgba(0,212,255,0.08)',
      color: '#00d4ff',
      padding: '8px 18px',
      borderRadius: '20px',
      fontSize: '13px',
      letterSpacing: '0.08em',
      border: '1px solid rgba(0,212,255,0.2)',
      textTransform: 'uppercase',
    },
    footer: {
      position: 'fixed',
      bottom: '18px',
      left: '28px',
      fontSize: '13px',
      color: '#1e3550',
      letterSpacing: '0.06em',
      zIndex: 10,
      userSelect: 'none',
    },
    scanline: {
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
      pointerEvents: 'none',
      zIndex: 0,
    },
  };

  const PainelOptica = () => (
    <>
      <p style={s.label}>Huawei iMaster &nbsp;·&nbsp; UNM2000 &nbsp;·&nbsp; AMS5520 &nbsp;·&nbsp; ZTE</p>
      <textarea
        value={entradaOptica}
        onChange={(e) => setEntradaOptica(e.target.value)}
        placeholder="Cole os alarmes ópticos aqui..."
        style={{ ...s.textarea(), height: '200px' }}
      />
      <div style={s.btnRow}>
        <button onClick={handleGerarOptica} style={s.btnPrimary}>▶ Gerar Ticket</button>
        <button onClick={handleCopiarOptica} style={s.btnSecondary(copiadoOptica)}>
          {copiadoOptica ? '✓ Copiado!' : '⧉ Copiar'}
        </button>
        <button onClick={handleLimparOptica} style={s.btnGhost}>✕ Limpar</button>
        {gerencia && (
          <span style={s.badge}>
            {ICON_GERENCIA[gerencia]} {LABEL_GERENCIA[gerencia] || gerencia}
          </span>
        )}
      </div>
      <textarea
        value={resultadoOptica}
        readOnly
        placeholder="Resultado aparecerá aqui..."
        style={{ ...s.textarea('#52e8a0'), height: '280px' }}
      />
    </>
  );

  const PainelConvencional = () => (
    <>
      <p style={s.label}>Interfaces Convencional &nbsp;/&nbsp; Metro</p>
      <textarea
        value={entradaConv}
        onChange={(e) => setEntradaConv(e.target.value)}
        placeholder="Cole os alarmes convencional/metro aqui..."
        style={{ ...s.textarea(), height: '200px' }}
      />
      <div style={s.btnRow}>
        <button onClick={handleGerarConv} style={s.btnPrimary}>▶ Gerar Ticket</button>
        <button onClick={handleCopiarConv} style={s.btnSecondary(copiadoConv)}>
          {copiadoConv ? '✓ Copiado!' : '⧉ Copiar'}
        </button>
        <button onClick={handleLimparConv} style={s.btnGhost}>✕ Limpar</button>
      </div>
      <textarea
        value={resultadoConv}
        readOnly
        placeholder="Resultado aparecerá aqui..."
        style={{ ...s.textarea('#52e8a0'), height: '280px' }}
      />
    </>
  );

  return (
    <div style={s.wrap}>
      <FiberBackground />
      <div style={s.scanline} />

      <div style={s.inner}>
        <div style={s.header}>
          <h1 style={s.title}>
            <span style={s.titleAccent}>NOC</span>
          </h1>
          <p style={s.subtitle}></p>
        </div>

        <div style={s.tabBar}>
          {[
            { id: 'optica',       label: '📡 Óptica / PON' },
            { id: 'convencional', label: '🖧 Convencional / Metro' },
          ].map(({ id, label }) => (
            <button key={id} style={s.tab(aba === id)} onClick={() => setAba(id)}>
              {label}
            </button>
          ))}
        </div>

        {aba === 'optica'       && <PainelOptica />}
        {aba === 'convencional' && <PainelConvencional />}
      </div>

      <div style={s.footer}>
        Desenvolvido por: Antonio André de Sousa Pinheiro
      </div>
    </div>
  );
}
