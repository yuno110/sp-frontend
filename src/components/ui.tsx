import { clsx } from 'clsx';
import {
  createContext,
  useContext,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
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

/**
 * 포커스 표시(`outline`)를 지우지 않는다 — 브라우저가 그리는 표시가 Tab 으로 옮긴 자리를 보인다(F-05). 선 색
 * (`focus:border-accent-500`)이 바뀌는 것만으로는 표시로 치지 않는다 — 검사가 보는 것은 `outline`·`box-shadow` 다
 * (e2e/checks.ts 의 `focusVisible`).
 */
const FIELD_BASE =
  'w-full rounded-md border border-line bg-elev px-2.5 py-1.5 text-sm text-default placeholder-faint focus:border-accent-500';

/** `Field` 가 그 입력칸에 주는 것 — 라벨이 가리키는 id, 안내와 오류를 읽히는 id, 오류가 있는가. */
const FieldContext = createContext<{ id: string; describedBy: string | undefined; invalid: boolean } | null>(null);

/** `Field` 안에 있으면 그 라벨·안내·오류에 이어진다. 밖에서 쓰면 이름은 쓰는 쪽이 준다(예: `aria-label`). */
function useFieldProps() {
  const field = useContext(FieldContext);
  return field ? { id: field.id, 'aria-describedby': field.describedBy, 'aria-invalid': field.invalid || undefined } : {};
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const field = useFieldProps();
  return <input {...field} className={clsx(FIELD_BASE, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useFieldProps();
  return <textarea {...field} className={clsx(FIELD_BASE, 'resize-y', className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useFieldProps();
  return <select {...field} className={clsx(FIELD_BASE, className)} {...rest} />;
}

/**
 * 입력칸 하나. `errors` 는 그 필드의 오류 메시지이고 입력칸 바로 아래에 그린다(lib/api/client.ts 의
 * `fieldMessages`). 그 필드를 요약에서 빼는 것은 같은 화면의 `ErrorBox` 의 `inlineFields` 다.
 *
 * **라벨은 `for` 로 입력칸을 가리키고 라벨 글자만 담는다**(F-05). 입력칸을 라벨로 감싸면 그 안의 안내 문구와 버튼(중복 확인)
 * 글자까지 입력칸의 이름이 된다. 안내와 오류는 `aria-describedby` 로 입력칸에 잇는다 — 입력칸에 가면 함께 읽힌다.
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
  const id = useId();
  const hintId = `${id}-hint`;
  const errorsId = `${id}-errors`;
  const describedBy = [hint ? hintId : null, errors.length > 0 ? errorsId : null].filter(Boolean).join(' ');
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      <FieldContext.Provider value={{ id, describedBy: describedBy || undefined, invalid: errors.length > 0 }}>
        {children}
      </FieldContext.Provider>
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-faint">
          {hint}
        </p>
      ) : null}
      <FieldErrors id={errorsId} messages={errors} />
    </div>
  );
}

/** 필드 오류 메시지. `Field` 로 감싸지 않은 입력칸은 그 바로 아래에 이것을 둔다. */
export function FieldErrors({ id, messages }: { id?: string; messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div id={id}>
      {messages.map((message, i) => (
        <p key={i} className="mt-1 text-xs text-danger-600">
          {message}
        </p>
      ))}
    </div>
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
