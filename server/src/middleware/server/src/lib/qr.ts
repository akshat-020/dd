import QRCode from "qrcode";

export async function generateQrPngBuffer(data: string): Promise<Buffer> {
  return QRCode.toBuffer(data, { type: "png", margin: 1, width: 320, errorCorrectionLevel: "M" });
}

export async function generateQrSvg(data: string): Promise<string> {
  return QRCode.toString(data, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}

// Encoding used on self-printed SKU batch labels: SKU code + batch/lot + date,
// e.g. "SKU:ACME-100|BATCH:B2026-07-12-01|DATE:2026-07-12"
export function encodeSkuBatchLabel(skuCode: string, batchCode: string, receivedDateISO: string) {
  return `SKU:${skuCode}|BATCH:${batchCode}|DATE:${receivedDateISO.slice(0, 10)}`;
}
