# caesura.mages.city

The board for Caesura. Plain HTML, one stylesheet, one script, no build step, no dependencies.
It reads every gate in `gates.json` live from NEAR testnet RPC in the browser; `roots.json` and
`board.json` are baked from the sealed bundles in `../bundles` by `npm run roots` and
`npm run board` at the repository root.

- `index.html` · `site.css` · `site.js` · `404.html` · `llms.txt` (agent door) · `robots.txt`
- `gates.json`: the gates the board reads (`id`, `owner`, `label`, `network`)
- `roots.json`: one line per sealed round (root, round, tx, attested, signed, ceremony, cost)
- `board.json`: the front, the attack × pair matrix and the studies
- Deploy: `npx wrangler deploy` from this folder (Cloudflare Workers static assets, `wrangler.jsonc`).
- Review locally: `npm run site` at the repository root, then http://127.0.0.1:8794/

Built by mages.city for NEAR.
