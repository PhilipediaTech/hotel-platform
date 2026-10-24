import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

const TONES = {
  info: { icon: Info, className: 'bg-brand-subtle text-brand-strong' },
  success: { icon: CheckCircle2, className: 'bg-success-subtle text-success' },
  critical: { icon: AlertTriangle, className: 'bg-critical-subtle text-critical' },
} as const;

/** Status message: always text plus an icon, never colour alone (tab 5 rule 3). */
export function Alert({
  tone,
  children,
  className,
}: {
  tone: keyof typeof TONES;
  children: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2 rounded-md p-3 text-sm', toneClass, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">{children}</div>
    </div>
  );
}
