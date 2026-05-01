import React, { useState } from 'react';

function extrairDados(linha) {
  const hostMatch = linha.match(/\s([a-zA-Z0-9\-]+)\s+Interface/);
  if (!hostMatch) return null;
  const host = hostMatch[1];

  const intfMatch = linha.match(/eth-(\d+\/\d+)/);
  if (!intfMatch) return null;
  const interfaceName = intfMatch[1];

  let cli = 'UNKNOWN';
  const cliMatch = linha.match(/CLI:([^\s#\)]*)/);
  if (cliMatch) {
    cli = cliMatch[1];
  } else {
    const altMatch = linha.match(/\(([^)]+)\)/);
    if (altMatch) cli = altMatch[1];
  }

  cli = cli.split(/[\s*]/)[0];
  return { host, interfaceName, cli };
}

function ordenarInterface(interfaceName) {
  const [a, b] = interfaceName.split('/').map(Number);
  return a * 1000 + b;
}

function processarAlarmes(texto) {
  const dados = {};
  const hosts = new Set();

  texto.split('\n').forEach((linha) => {
    const resultado = extrairDados(linha.trim());
    if (!resultado) return;

    const { host, interfaceName, cli } = resultado;
    hosts.add(host);

    if (!dados[host]) dados[host] = [];
    dados[host].push({ interfaceName, cli });
  });

  if (Object.keys(dados).length === 0) {
    return 'Nenhum alarme válido encontrado.';
  }

  const agora = new Date().toLocaleString('pt-BR');
  const equipamentos = Array.from(hosts).sort().join(', ');

  let saida = `-:CARIMBO DE ABERTURA - NOC:-.
Falha: Indisponibilidade em rede convencional/metro
Equipamento:
${equipamentos}
Alarme: loss
Data/Hora: ${agora} BRT
IP: XXXXXXXXXXXXXXX

41-3318-7732 - Op.4

`;

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
    <div
      style={{
        padding: '20px',
        fontFamily: 'Arial',
        maxWidth: '1000px',
        margin: '0 auto',
      }}
    >
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
        placeholder="Resultado aparecerá aqui..."
        style={{
          width: '100%',
          height: '250px',
          padding: '10px',
        }}
      />
    </div>
  );
}
