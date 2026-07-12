import { useEffect, useRef, useState } from "react";
import QrScanner from "qr-scanner";

interface Props {
  title: string;
  onDecode: (text: string) => void;
  onClose: () => void;
}

// Camera-based QR scanner (phone camera, no dedicated hardware required).
// Also offers a manual-entry fallback for low-light/no-camera situations —
// keeps the picking flow usable even if scanning briefly fails.
export function QrScannerModal({ title, onDecode, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const [manualValue, setManualValue] = useState("");
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        onDecode(result.data);
      },
      { highlightScanRegion: true, highlightCodeOutline: true, maxScansPerSecond: 5 }
    );
    scannerRef.current = scanner;
    scanner.start().catch((err) => setCameraError(err instanceof Error ? err.message : "Camera unavailable"));
    return () => {
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      <div className="flex items-center justify-between p-4 text-white">
        <span className="font-medium">{title}</span>
        <button onClick={onClose} className="rounded-full bg-white/20 px-3 py-1 text-sm">
          Close
        </button>
      </div>

      <div className="relative mx-auto aspect-square w-full max-w-md overflow-hidden">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
      </div>

      {cameraError && (
        <p className="mx-4 mt-2 rounded-lg bg-red-950 px-3 py-2 text-center text-sm text-red-300">
          Camera unavailable ({cameraError}). Use manual entry below.
        </p>
      )}

      <div className="mt-auto space-y-2 p-4">
        <p className="text-center text-xs text-white/60">Or enter the code manually</p>
        <div className="flex gap-2">
          <input
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            className="flex-1 rounded-lg border border-white/30 bg-white/10 px-3 py-3 text-white outline-none"
            placeholder="Type code…"
          />
          <button
            onClick={() => manualValue && onDecode(manualValue)}
            className="rounded-lg bg-white px-4 py-3 font-medium text-slate-900"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
