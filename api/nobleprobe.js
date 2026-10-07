// sonda de diagnóstico: revela si las librerías de firma cargan en Vercel
let report = { secp256k1: null, hmac: null, sha256: null, sha3: null, node: process.version };
try { report.secp256k1 = !!(require('@noble/secp256k1').sign); } catch (e) { report.secp256k1 = String(e); }
try { report.hmac = !!require('@noble/hashes/hmac').hmac; } catch (e) { report.hmac = String(e); }
try { report.sha256 = !!require('@noble/hashes/sha256').sha256; } catch (e) { report.sha256 = String(e); }
try { report.sha3 = !!require('@noble/hashes/sha3').keccak_256; } catch (e) { report.sha3 = String(e); }
const wrap = require('./_cors');
module.exports = wrap((req, res) => res.status(200).json(report));
