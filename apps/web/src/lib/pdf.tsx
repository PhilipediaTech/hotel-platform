import { useState } from 'react';
import { Alert } from '../components/ui/alert.tsx';
import { errorMessage } from './form.ts';

// Opening a PDF the API makes (invoices, receipts, night audit reports): the file is fetched
// with the session and shown from a blob URL.

/**
 * Shows a PDF in a new tab. The tab is opened before the download (browsers block pop-ups
 * that open after a wait); without one, the file is saved instead.
 */
export function usePdf() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const open = async (fetchFile: () => Promise<Blob>, filename: string) => {
    setError(null);
    setBusy(true);
    const tab = window.open('', '_blank');
    try {
      const url = URL.createObjectURL(await fetchFile());
      if (tab) {
        tab.location.href = url;
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { open, error, busy };
}

export function PdfError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert tone="critical" className="mt-2">
      {errorMessage(error)}
    </Alert>
  );
}
