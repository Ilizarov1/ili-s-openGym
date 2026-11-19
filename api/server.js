/* The API entry point.
 *
 * The server itself is the compiled Nest application under dist/src/main.js.
 * This file only loads it, so `node server.js`, `npm start` and
 * `node dist/src/main.js` start the same thing. Build first: `npm run build`.
 *
 * Nothing here reads the environment or starts a timer: the compiled entry
 * owns the boot line, the HTTP server, the background timers and the shutdown
 * signals.
 */
try {
  await import('./dist/src/main.js');
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('api: the compiled entry is missing — run `npm run build` in api/ first.');
  } else {
    console.error('api: the compiled entry failed to load:', error?.message || error);
  }
  process.exit(1);
}
