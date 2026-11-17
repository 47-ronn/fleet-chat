// QR generation — thin wrapper over `qrcode-generator` (Kazuhiko Arase's
// reference implementation, MIT). Returns a boolean[][] matrix to render.
import qrcodegen from 'qrcode-generator';

export function qrMatrix(text) {
  const qr = qrcodegen(0, 'M'); // type auto, ECC level M
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(!!qr.isDark(r, c));
    m.push(row);
  }
  return m;
}