const wrap = require('./_cors');
module.exports = wrap(async (req, res) => {
  const body = req.body || {};
  const addr = String(body.address || '0xe52db1a866b73D3a0091F748ce0e5916A992a847');
  const payload = { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [addr, 'pending'] };
  const out = { addrLen: addr.length, addrHead: addr.slice(0, 12), results: [] };
  for (const url of ['https://worldchain-mainnet.g.alchemy.com/public', 'https://worldchain.drpc.org']) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const text = await r.text();
      out.results.push({ url: url.split('/')[2], status: r.status, head: text.slice(0, 220) });
    } catch (e) { out.results.push({ url: url.split('/')[2], error: String(e).slice(0, 200) }); }
  }
  res.json(out);
});
