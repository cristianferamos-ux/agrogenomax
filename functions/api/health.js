import { json } from '../_data/agxStatic.js';

export function onRequestGet() {
  return json({ ok: true, database: 'pages-static-fallback', schema: 'agx' });
}
