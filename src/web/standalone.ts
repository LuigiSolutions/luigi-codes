/**
 * Luigi Codes — standalone web app launcher.
 *
 * Runs the Luigi web chat without VS Code at all:
 *
 *   npm run web -- --endpoint http://localhost:8080 --provider custom --lan
 *
 * Options:
 *   --port <n>         port to listen on (default 8091)
 *   --lan              bind 0.0.0.0 so phones on your Wi-Fi can connect
 *   --endpoint <url>   inference server URL (default http://localhost:11434)
 *   --provider <p>     ollama | lmstudio | custom (default ollama)
 *   --model <id>       preferred model id (default: first the server reports)
 *   --theme <t>        premium-black | premium-dark (default premium-black)
 *
 * Zero dependencies, same guarantees as the extension: everything stays on
 * your machine / your network, and the printed URL carries the access token.
 */
import * as path from 'node:path';
import { LuigiBrand, LuigiTheme } from '../ui/designTokens';
import { LuigiWebServer, WireFormat } from './webServer';

// 24-bit ANSI straight from the brand tokens — no hardcoded values.
const GOLD = ansiFromHex(LuigiBrand.colors.accent.gold);
const MUTED = ansiFromHex(LuigiBrand.colors.foreground.secondary);
const RESET = '\x1b[0m';

function ansiFromHex(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const provider = arg('provider') ?? 'ollama';
  const theme = arg('theme');
  const server = new LuigiWebServer({
    host: flag('lan') ? '0.0.0.0' : '127.0.0.1',
    port: Number(arg('port') ?? 8091),
    modelEndpoint: arg('endpoint') ?? 'http://localhost:11434',
    wire: (provider === 'ollama' ? 'ollama' : 'openai') as WireFormat,
    model: arg('model'),
    theme: theme === 'premium-dark' || theme === 'premium-black' ? (theme as LuigiTheme) : undefined,
    // out/web/standalone.js → repo root → media/
    mediaDir: path.resolve(__dirname, '..', '..', 'media'),
    log: (message) => console.log(`${MUTED}${message}${RESET}`),
  });

  const { urls } = await server.start();
  console.log('');
  console.log(`${GOLD}🍄 LUIGI CODES${RESET}${MUTED} — web chat · local · private${RESET}`);
  console.log('');
  console.log(`${MUTED}Open on this machine:${RESET}`);
  console.log(`  ${GOLD}${urls[0]}${RESET}`);
  if (urls.length > 1) {
    console.log(`${MUTED}Open on your phone (same Wi-Fi):${RESET}`);
    for (const url of urls.slice(1)) {
      console.log(`  ${GOLD}${url}${RESET}`);
    }
  } else if (!flag('lan')) {
    console.log(`${MUTED}Tip: add --lan to also reach it from your phone on this Wi-Fi.${RESET}`);
  }
  console.log('');
  console.log(`${MUTED}The link carries this session's access token. Ctrl+C to stop.${RESET}`);

  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error) => {
  console.error(`Luigi web app failed to start: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
