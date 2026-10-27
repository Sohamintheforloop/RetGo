import worker from './.out.mjs'
// in-memory KV with metadata + list
const store = new Map()
const KV = {
  async put(k, v, o = {}) { store.set(k, { v, meta: o.metadata }) },
  async get(k) { return store.get(k)?.v ?? null },
  async delete(k) { store.delete(k) },
  async list({ prefix }) { return { keys: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.meta })) } },
}
// mock Groq
let lastAuth = ''
let groqCalls = 0
globalThis.fetch = async (url, init) => {
  lastAuth = init.headers.Authorization
  groqCalls++
  const sys = JSON.parse(init.body).messages[0].content
  const content = sys.includes('patch plan')
    ? JSON.stringify({ registry_fixes: [{ path: 'HKEY_CURRENT_USER\\SOFTWARE\\RetroPatcherDemo\\MaxPayne', name: 'ForceSingleCore', value: '1', type: 'REG_DWORD' }], hex_offsets: [{ offset: '0x1A2B3C', original: '74 05 90 90', replace: 'EB 05 90 90' }] })
    : JSON.stringify({ likely_causes: ['Old audio driver'], suggestions: ['Run as administrator', 'Use compatibility mode'], needs_community_fix: true })
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}
const env = { GROQ_API_KEY: 'x', REQUESTS: KV, MAINTAINER_TOKEN: 'secret-token' }
const call = async (method, path, body, headers = {}) => {
  const r = await worker.fetch(new Request('http://x' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env)
  return { status: r.status, body: await r.json().catch(() => null), cors: r.headers.get('access-control-allow-origin') }
}
let failures = 0
const ok = (name, cond, extra = '') => { if (!cond) failures++; console.log((cond ? 'PASS ' : 'FAIL ') + name + extra) }
let r = await call('GET', '/api/games'); ok('catalog 5 games, no wiki text leak', r.body.games.length === 5 && !JSON.stringify(r.body).includes('wiki_text'))
const mp2 = r.body.games.find((g) => g.id === 'max_payne_2'), mp = r.body.games.find((g) => g.id === 'max_payne'), demo = r.body.games.find((g) => g.id === 'demo_game'), st = r.body.games.find((g) => g.id === 'stalker')
ok('catalog reports has_plan / file_fixes', mp.has_plan === false && mp.file_fixes === 1 && mp2.has_plan === false && mp2.file_fixes === 1 && demo.has_plan === true && demo.file_fixes === 1 && st.file_fixes === 0)
r = await call('POST', '/api/patch-plan', { game_id: 'demo_game' }); ok('patch plan validated + DWORD coerced', r.status === 200 && r.body.registry_fixes[0].value === 1)
r = await call('POST', '/api/patch-plan', { game_id: 'nope' }); ok('unknown game rejected', r.status === 400)
r = await call('POST', '/api/diagnose', { title: 'Cool Game', exe_name: 'cool.exe', os: 'Windows 11', symptoms: 'Crashes at start. Log in C:\\Users\\Bob\\game.log' }); ok('AI advice', r.status === 200 && r.body.suggestions.length === 2)
r = await call('POST', '/api/diagnose', { title: 'Cool Game', exe_name: 'cool.exe', os: 'Windows 11', symptoms: 'where do I find a no-cd crack for this' }); ok('piracy refused (422)', r.status === 422)
r = await call('POST', '/api/requests', { kind: 'public', title: 'Cool Game', exe_name: 'cool.exe', os: 'Windows 11', symptoms: 'Black screen. Mail me bob@mail.com or see C:\\Users\\Bob\\x.txt at 10.0.0.5 https://evil.example' })
const pub = r.body; ok('public created', r.status === 201 && pub.delete_token)
const stored = JSON.parse(store.get('pub:' + pub.id).v); ok('PII scrubbed server-side', !/bob|10\.0|evil|C:\\/i.test(stored.symptoms), ' -> ' + stored.symptoms)
ok('only token HASH stored', store.get('del:' + pub.id).v.length === 64 && store.get('del:' + pub.id).v !== pub.delete_token)
r = await call('GET', '/api/requests/public'); ok('public list', r.body.items.length === 1)
r = await call('POST', '/api/requests/delete', { id: pub.id, delete_token: 'wrong' }); ok('delete with wrong token refused', r.status === 403)
r = await call('POST', '/api/requests/delete', { id: pub.id, delete_token: pub.delete_token }); ok('delete with right token', r.status === 200 && !store.has('pub:' + pub.id) && !store.has('del:' + pub.id))
const env1 = { v: 1, epk: 'A'.repeat(86) + '==', iv: 'A'.repeat(14) + '==', ct: 'QUJD'.repeat(10) }
r = await call('POST', '/api/requests', { kind: 'private', envelope: env1 }); const priv = r.body; ok('private stored as ciphertext only', r.status === 201 && store.get('priv:' + priv.id).v.includes('"ct"'))
r = await call('POST', '/api/requests', { kind: 'private', envelope: { v: 1, epk: 'bad', iv: 'x', ct: 'y' } }); ok('malformed envelope rejected', r.status === 400)
r = await call('GET', '/api/maintainer/inbox'); ok('inbox needs token', r.status === 401)
r = await call('GET', '/api/maintainer/inbox', null, { Authorization: 'Bearer wrong' }); ok('inbox wrong token', r.status === 401)
r = await call('GET', '/api/maintainer/inbox', null, { Authorization: 'Bearer secret-token' }); ok('inbox with token', r.status === 200 && r.body.items.length === 1)
r = await call('POST', '/api/maintainer/reply', { id: priv.id, envelope: env1 }, { Authorization: 'Bearer secret-token' }); ok('maintainer reply stored', r.status === 200)
r = await call('GET', '/api/replies/' + priv.id); ok('user fetches reply', r.body.reply?.v === 1)
const pf = await worker.fetch(new Request('http://x/api/requests', { method: 'OPTIONS' }), env); ok('CORS preflight 204', pf.status === 204 && pf.headers.get('access-control-allow-origin') === '*')

r = await call('POST', '/api/patch-plan', { game_id: 'demo_game' }); ok('shared key used when none supplied', lastAuth === 'Bearer x')
r = await call('POST', '/api/patch-plan', { game_id: 'demo_game' }, { 'X-Groq-Key': 'gsk_' + 'a'.repeat(30) }); ok('user key used for this request', r.status === 200 && lastAuth === 'Bearer gsk_' + 'a'.repeat(30))
r = await call('POST', '/api/diagnose', { title: 'Cool Game', exe_name: 'cool.exe', os: 'Windows 11', symptoms: 'Crashes at the main menu on start' }, { 'X-Groq-Key': 'gsk_' + 'b'.repeat(30) }); ok('user key used for AI advice', r.status === 200 && lastAuth.endsWith('b'.repeat(30)))
r = await call('POST', '/api/patch-plan', { game_id: 'demo_game' }, { 'X-Groq-Key': 'not a key; drop table' }); ok('malformed key rejected (400)', r.status === 400)
const pf2 = await worker.fetch(new Request('http://x/api/patch-plan', { method: 'OPTIONS' }), env); ok('CORS allows X-Groq-Key', pf2.headers.get('access-control-allow-headers').includes('X-Groq-Key'))

groqCalls = 0
r = await call('POST', '/api/patch-plan', { game_id: 'max_payne_2' }); ok('real game (file fixes only): empty plan, no AI call, no key needed', r.status === 200 && r.body.registry_fixes.length === 0 && r.body.hex_offsets.length === 0 && groqCalls === 0)
console.log(failures === 0 ? '\nAll worker tests passed.' : `\n${failures} worker test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
