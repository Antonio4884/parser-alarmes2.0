import React, { useState } from 'react';

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

function extrairDados(linha) {
  const horarioMatch = linha.match(/(\d{1,2}:\d{2}:\d{2}\s?(AM|PM))/i);
  const horarioOriginal = horarioMatch ? horarioMatch[1] : null;
  const horario = horarioOriginal
    ? converterHorario24h(horarioOriginal)
    : null;

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

function ordenarInterface(interfaceName) {
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
  const divergentes = [];

  lista.forEach((item) => {
    const atual = horarioParaSegundos(item.horario);
    const diferenca = Math.abs(atual - base);

    if (diferenca >= 1800) {
      divergentes.push(item);
    }
  });

  return divergentes;
}

function processarAlarmes(texto) {
  const dados = {};
  const hosts = new Set();
  const todasInterfaces = [];

  texto.split('\n').forEach((linha) => {
    const resultado = extrairDados(linha.trim());
    if (!resultado) return;

    const { host, interfaceName, cli, horario } = resultado;

    hosts.add(host);
    todasInterfaces.push(resultado);

    if (!dados[host]) dados[host] = [];
    dados[host].push({ interfaceName, cli, horario });
  });

  if (Object.keys(dados).length === 0) {
    return 'Nenhum alarme válido encontrado.';
  }

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

  Object.keys(dados)
    .sort()
    .forEach((host) => {
      saida += `${host}\n`;

      dados[host]
        .sort(
          (a, b) =>
            ordenarInterface(a.interfaceName) -
            ordenarInterface(b.interfaceName)
        )
        .forEach(({ interfaceName, cli }) => {
          saida += `${interfaceName} CLI:${cli}\n`;
        });

      saida += '\n';
    });

  return saida.trim();
}

export default function App() {
  const [entrada, setEntrada] = useState('');
  const [resultado, setResultado] = useState('');

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial', maxWidth: '1000px', margin: '0 auto' }}>
      <h1>🔧 Interfaces Convencional</h1>

      <textarea
        value={entrada}
        onChange={(e) => setEntrada(e.target.value)}
        placeholder="Cole os alarmes aqui..."
        style={{
          width: '100%',
          height: '250px',
          padding: '10px',
          marginBottom: '10px',
        }}
      />

      <div style={{ marginBottom: '10px' }}>
        <button
          onClick={() => setResultado(processarAlarmes(entrada))}
          style={{ marginRight: '10px', padding: '10px 20px' }}
        >
          Processar
        </button>

        <button
          onClick={() => {
            setEntrada('');
            setResultado('');
          }}
          style={{ padding: '10px 20px' }}
        >
          Limpar
        </button>
      </div>

      <textarea
        value={resultado}
        readOnly
        style={{
          width: '100%',
          height: '250px',
          padding: '10px',
        }}
      />
    </div>
  );
}
