// stub de diagnostico
const wrap = require('./_cors');
module.exports = wrap(async (req, res) => {
  res.status(200).json({ ok: true, hist: [] });
});
