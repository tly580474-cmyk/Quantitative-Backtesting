import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = Number(process.env.M4_ALERT_DRILL_PORT ?? 39041);
const outputPath = resolve(process.env.M4_ALERT_DRILL_OUTPUT ?? '.codex-runtime/m4-production-drill/alert-delivery.json');
const received = [];

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ method: request.method, url: request.url, payload });
      response.writeHead(204).end();
      if (received.length >= 2) {
        await writeFile(outputPath, `${JSON.stringify({ status: 'passed', received }, null, 2)}\n`, 'utf8');
        server.close();
      }
    } catch (error) {
      response.writeHead(400).end(error instanceof Error ? error.message : 'invalid payload');
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`M4 alert drill receiver listening on http://127.0.0.1:${port}/alerts\n`);
});
