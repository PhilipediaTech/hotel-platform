import { useId, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';

/** Centred card for the signed-out screens (S01, S02). */
export function AuthLayout() {
  const { t } = useTranslation();
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center p-4">
      <p className="mb-6 text-lg font-semibold text-brand-strong">{t('app.name')}</p>
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
        <Outlet />
      </div>
    </main>
  );
}

export function AuthHeading({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <header className="mb-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      {intro && <p className="mt-1 text-sm text-text-muted">{intro}</p>}
    </header>
  );
}

/** Labelled input with its error announced to screen readers. */
export function Field({
  label,
  error,
  hint,
  ...input
}: { label: string; error?: string | undefined; hint?: string } & ComponentProps<'input'>) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div className="mb-4 flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        {...input}
      />
      {error ? (
        <p id={messageId} className="text-sm text-critical">
          {error}
        </p>
      ) : (
        hint && (
          <p id={messageId} className="text-xs text-text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
