import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { describeError } from '@/lib/api/client';
import type { Meanings, Recovery } from '@/lib/api/errorCodes';
import { DEV_ONLY } from '@/lib/devOnly';

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

/**
 * 입력칸 하나. `errors` 는 그 필드의 오류 메시지이고 입력칸 바로 아래에 그린다(lib/api/client.ts 의
 * `fieldMessages`). 그 필드를 요약에서 빼는 것은 같은 화면의 `ErrorBox` 의 `inlineFields` 다.
 */
export function Field({
  label,
  hint,
  errors = [],
  children,
}: {
  label: string;
  hint?: ReactNode;
  errors?: string[];
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
        {children}
        {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
      </label>
      <FieldErrors messages={errors} />
    </div>
  );
}

/** 필드 오류 메시지. `Field` 로 감싸지 않은 입력칸은 그 바로 아래에 이것을 둔다. */
export function FieldErrors({ messages }: { messages: string[] }) {
  return messages.map((message, i) => (
    <p key={i} className="mt-1 text-xs text-danger-600">
      {message}
    </p>
  ));
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

const RECOVERY: Record<Recovery, { to: string; label: string }> = {
  profile: { to: '/signup/profile', label: '프로필 등록하기' },
  login: { to: '/login', label: '로그인하기' },
};

function RecoveryLink({ recovery, className }: { recovery: Recovery; className?: string }) {
  const { to, label } = RECOVERY[recovery];
  // 이미 그 화면이면 두지 않는다 — 로그인 화면이 세션을 끝낸 실패를 보일 때가 그렇다.
  const here = useLocation().pathname === to;
  if (here) return null;
  return (
    <Link to={to} className={clsx('font-medium underline', className)}>
      {label}
    </Link>
  );
}

/** 오류 코드 자리. 화면 문구 검사(src/test/internalCopy.ts)는 이 자리만 뺀다 — 코드는 여기에만 둔다. */
function CodeTag({ code }: { code: string }) {
  return (
    <span className="font-mono" data-error-code={code}>
      {code}
    </span>
  );
}

/**
 * 오류를 사용자 말로 보여준다(lib/api/client.ts 의 `describeError`). **코드는 작게라도 남기고, `fieldErrors` 는
 * 한 건도 버리지 않는다** — 입력칸이 있는 필드는 그 옆에(`Field` 의 `errors`), 나머지는 여기 요약에 둔다.
 * `inlineFields` 는 이 화면이 지금 입력칸 옆에 그리는 필드다. 그 입력칸이 그려지지 않는 상태면 넘기지 않는다 —
 * 넘기면 그 오류가 어디에도 보이지 않는다.
 */
export function ErrorBox({
  error,
  meanings,
  inlineFields = [],
}: {
  error: unknown;
  meanings?: Meanings;
  inlineFields?: readonly string[];
}) {
  if (error == null) return null;
  const view = describeError(error, meanings);
  const rest = view.fieldErrors.filter((f) => !inlineFields.includes(f.field));
  return (
    <div className="rounded-md border border-line bg-danger-50 px-3 py-2 text-sm text-danger-600">
      <p>{view.text}</p>
      {rest.length > 0 ? (
        <ul className="mt-1 list-inside list-disc text-xs">
          {rest.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      ) : null}
      {view.recovery ? <RecoveryLink recovery={view.recovery} className="mt-1 inline-block" /> : null}
      {view.code ? (
        <p className="mt-1 text-xs text-faint">
          오류 코드 <CodeTag code={view.code} />
        </p>
      ) : null}
      {DEV_ONLY && view.detail ? <p className="mt-1 font-mono text-xs">{view.detail}</p> : null}
    </div>
  );
}

/** `ErrorBox` 를 한 줄로 — 머리글처럼 자리가 좁은 곳에 쓴다. 담는 것은 같다. */
export function ErrorLine({ error, meanings }: { error: unknown; meanings?: Meanings }) {
  if (error == null) return null;
  const view = describeError(error, meanings);
  return (
    <span className="text-danger-600">
      {view.text}
      {view.fieldErrors.map((f, i) => (
        <span key={i}> · {f.message}</span>
      ))}
      {view.recovery ? (
        <>
          {' '}
          <RecoveryLink recovery={view.recovery} />
        </>
      ) : null}
      {view.code ? (
        <span className="text-xs text-faint">
          {' ('}
          <CodeTag code={view.code} />)
        </span>
      ) : null}
      {DEV_ONLY && view.detail ? <span className="font-mono text-xs"> {view.detail}</span> : null}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-faint">{children}</div>;
}
