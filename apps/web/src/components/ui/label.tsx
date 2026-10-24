import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.ts';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-text', className)} {...props} />;
}
