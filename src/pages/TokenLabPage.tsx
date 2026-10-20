import { useState } from 'react';
import http, { messageOf } from '@/lib/api/client';
import { reissue } from '@/features/auth/api';
import { decodeClaims, secondsUntilExpiry } from '@/lib/jwt';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorBox, Field, Input, Panel } from '@/components/ui';

/**
 * 토큰 실험 — A001·A002·A003 의 경계를 눈으로 본다 (api-contract.md §8.5).
 *
 * 경계는 RFC 6750 의 b64token 문법이다: 헤더가 없거나 문법을 위반하면 A001(애초에 bearer
 * 자격증명이 아니다), 문법은 맞고 해석에 실패하면 A002, exp 가 지났으면 A003.
 *
 * **여기서 만들 수 없는 것도 있다.** 만료 토큰과 claim 계약 위반 토큰은 개인키로 서명해야
 * 만들어지고, 개인키는 이 저장소에 없다(있어서도 안 된다). 그래서 "만료 + 계약 위반이 겹칠 때
 * member 는 A002, auth·board 는 A003" 이라는 D-05 실측은 이 화면으로 재현되지 않는다 —
 * 그 측정은 서버 쪽에서 서명한 토큰으로 했다.
 */
const PRESETS: Array<{ label: string; value: string | null; expect: string }> = [
  { label: '헤더 없음', value: null, expect: 'A001 — 제시된 자격증명이 없다' },
  { label: 'Bearer (값 없음)', value: '', expect: 'A001 — 같은 이유' },
  { label: 'Basic abc', value: 'RAW:Basic abc', expect: 'A001 — 다른 스킴' },
  { label: 'Bearer not!a!token', value: 'not!a!token', expect: 'A001 — b64token 문법 위반' },
  { label: 'Bearer abc.def.ghi', value: 'abc.def.ghi', expect: 'A002 — 제시됐고 해석에 실패했다' },
];

const TARGETS = [
  { label: 'auth — GET /api/v1/accounts/me', path: '/api/v1/accounts/me' },
  { label: 'member — GET /api/v1/members/me', path: '/api/v1/members/me' },
  { label: 'board — GET /api/v1/posts/me', path: '/api/v1/posts/me' },
];

export function TokenLabPage() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const setTokens = useAuthStore((s) => s.setTokens);
  const [target, setTarget] = useState(TARGETS[0].path);
  // 회전으로 밀려난 직전 Refresh Token. 스토어는 새 것으로 덮이므로 여기 따로 둔다.
  const [usedRefreshToken, setUsedRefreshToken] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [result, setResult] = useState<string | null>(null);
  // 기대한 성공인지 기대와 다른 성공인지. 뒤쪽을 초록으로 칠하면 문장과 색이 어긋난다.
  const [resultKind, setResultKind] = useState<'ok' | 'unexpected'>('ok');
  const [error, setError] = useState<string | null>(null);

  const claims = decodeClaims(accessToken);
  const expiresIn = secondsUntilExpiry(claims);

  const fire = async (header: string | null) => {
    setResult(null);
    setResultKind('ok');
    setError(null);
    try {
      // null = 헤더를 지운다. 인터셉터가 Authorization 을 이미 들고 있으면 덮어쓰지 않는다.
      const value =
        header === null
          ? null
          : header.startsWith('RAW:')
            ? header.slice(4)
            : `Bearer ${header}`;
      const res = await http.get(target, {
        headers: { Authorization: value as unknown as string },
      });
      setResult(`${res.status} — 통과했다`);
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-default">토큰 실험</h1>

      <Panel title="현재 토큰">
        {claims ? (
          <dl className="space-y-1.5 font-mono text-xs">
            <div className="flex gap-2">
              <dt className="w-16 text-muted">sub</dt>
              <dd className="text-default">{claims.sub}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 text-muted">role</dt>
              <dd className="text-default">{claims.role}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 text-muted">iss</dt>
              <dd className="text-default">{claims.iss}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 text-muted">exp</dt>
              <dd className={expiresIn !== null && expiresIn < 0 ? 'text-danger-600' : 'text-default'}>
                {expiresIn}s 남음
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-faint">토큰이 없다. 로그인하면 claim 이 여기 보인다.</p>
        )}
        <p className="mt-2 text-xs text-faint">
          서명을 검증하지 않고 payload 만 읽어 보여준다 — 판정은 전부 서버가 한다.
        </p>
      </Panel>

      <Panel title="수동 재발급 — 회전 확인">
        <p className="text-xs text-muted">
          Refresh Token 은 재발급 때 회전 발급된다(api-contract.md §2.1, security.md §1).
          그래서 응답의 refreshToken 까지 함께 저장해야 하고, accessToken 만 받으면 두 번째
          갱신부터 막힌다.
        </p>
        <p className="mt-2 text-xs text-muted">
          <b>버튼을 두 번 누르는 것으로는 회전이 보이지 않는다</b> — 두 번째 누름은 이미 갱신된
          새 토큰을 보내므로 둘 다 성공한다. 회전을 보려면 <b>밀려난 토큰을 다시 보내야</b> 한다.
          재발급 거부는 만료만 A003 이고 나머지는 전부 A002 다(§8.5) — 쓰인 토큰도 그쪽이다.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!refreshToken}
            onClick={() =>
              void (async () => {
                setResult(null);
                setError(null);
                if (!refreshToken) return;
                const sent = refreshToken;
                try {
                  const next = await reissue(sent);
                  setTokens(next);
                  setUsedRefreshToken(sent);
                  const rotated = next.refreshToken !== sent;
                  setResultKind(rotated ? 'ok' : 'unexpected');
                  setResult(
                    rotated
                      ? `재발급 성공 — refreshToken 이 회전했다. accessTokenExpiresIn ${next.accessTokenExpiresIn}s`
                      : '재발급 성공 — 그런데 refreshToken 이 그대로다 (회전이 안 됐다)',
                  );
                } catch (e) {
                  setError(messageOf(e));
                }
              })()
            }
          >
            POST /api/v1/auth/reissue — 현재 토큰
          </Button>
          <Button
            disabled={!usedRefreshToken}
            onClick={() =>
              void (async () => {
                setResult(null);
                setError(null);
                if (!usedRefreshToken) return;
                try {
                  const next = await reissue(usedRefreshToken);
                  // 이 성공은 기대와 다른 답이다. 색도 그렇게 칠한다.
                  setResultKind('unexpected');
                  setResult(
                    `밀려난 토큰이 또 통과했다 — 회전이 무효화되지 않았다 (expiresIn ${next.accessTokenExpiresIn}s)`,
                  );
                } catch (e) {
                  setError(messageOf(e));
                }
              })()
            }
          >
            밀려난 토큰 재사용 (401 A002 예상)
          </Button>
        </div>
        <p className="mt-2 font-mono text-xs text-faint">
          {refreshToken ? `현재 …${refreshToken.slice(-12)}` : 'refreshToken 이 없다'}
          {usedRefreshToken ? ` · 밀려난 것 …${usedRefreshToken.slice(-12)}` : ''}
        </p>
        <p className="mt-2 text-xs text-faint">
          두 번째 버튼이 성공하면 그것은 <b>결함</b>이다. 결과를 화면에 그대로 적는다 — 기대와
          다른 답을 성공으로 칠하지 않는다.
        </p>
      </Panel>

      <Panel title="요청 보내기">
        <Field label="대상">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full rounded-md border border-line bg-elev px-2.5 py-1.5 text-sm"
          >
            {TARGETS.map((t) => (
              <option key={t.path} value={t.path}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="mt-3 space-y-2">
          {PRESETS.map((p) => (
            <div key={p.label} className="flex items-center gap-2">
              <Button className="w-56 justify-start" onClick={() => void fire(p.value)}>
                {p.label}
              </Button>
              <span className="text-xs text-faint">{p.expect}</span>
            </div>
          ))}
        </div>

        <form
          className="mt-4 flex items-end gap-2 border-t border-line-soft pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void fire(raw);
          }}
        >
          <div className="flex-1">
            <Field label="직접 입력한 토큰" hint="Bearer 접두어는 자동으로 붙는다">
              <Input value={raw} onChange={(e) => setRaw(e.target.value)} className="font-mono" />
            </Field>
          </div>
          <Button type="submit" variant="primary">
            보내기
          </Button>
        </form>

        {result ? (
          <div
            className={
              resultKind === 'ok'
                ? 'mt-3 rounded-md border border-line bg-success-50 px-3 py-2 text-sm text-success-600'
                : 'mt-3 rounded-md border border-line bg-warn-50 px-3 py-2 text-sm text-warn-600'
            }
          >
            {resultKind === 'ok' ? '' : '기대와 다른 답이다 — '}
            {result}
          </div>
        ) : null}
        <div className="mt-3">
          <ErrorBox message={error} />
        </div>
        <p className="mt-3 text-xs text-faint">
          결과는 아래 요청 기록에도 남는다. 만료 토큰은 여기서 만들 수 없다 — 개인키로 서명해야
          하고 그 키는 이 저장소에 없다. 만료를 보려면 30분을 기다리거나 서버 쪽에서 서명한다.
        </p>
      </Panel>
    </div>
  );
}
