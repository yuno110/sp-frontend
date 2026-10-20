import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

/**
 * 최소 UI 프리미티브. 색은 시맨틱 토큰으로만 쓴다(src/index.css) —
 * jworksuite6 `components/ui/` 와 같은 어휘다.
 */

type ButtonVariant = 'primary' | 'ghost' | 'danger';

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-accent-600 text-white hover:bg-accent-700 border-transparent',
  ghost: 'bg-elev text-default hover:bg-subtle border-line border',
  danger: 'bg-danger-500 text-white hover:bg-danger-600 border-transparent',
};

export function Button({
  variant = 'ghost',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON[variant],
        className,
      )}
      {...rest}
    />
  );
}

const FIELD_BASE =
  'w-full rounded-md border border-line bg-elev px-2.5 py-1.5 text-sm text-default placeholder-faint focus:border-accent-500 focus:outline-none';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(FIELD_BASE, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(FIELD_BASE, 'resize-y', className)} {...rest} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

export function Panel({
  title,
  right,
  children,
  className,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-md border border-line bg-elev', className)}>
      {title ? (
        <header className="flex items-center justify-between gap-2 border-b border-line-soft px-4 py-2.5">
          <h2 className="text-sm font-semibold text-default">{title}</h2>
          {right}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** 서버가 보낸 코드·메시지·fieldErrors 를 가공 없이 보여준다. */
export function ErrorBox({ message, fields }: { message: string | null; fields?: string[] }) {
  if (!message) return null;
  return (
    <div className="rounded-md border border-line bg-danger-50 px-3 py-2 text-sm text-danger-600">
      <div className="font-mono">{message}</div>
      {fields && fields.length > 0 ? (
        <ul className="mt-1 list-inside list-disc text-xs">
          {fields.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-faint">{children}</div>;
}
