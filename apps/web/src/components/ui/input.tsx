import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

// shadcn/ui Input, adapted to the project tokens.
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-text-muted',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-critical',
        className,
      )}
      {...props}
    />
  );
}
