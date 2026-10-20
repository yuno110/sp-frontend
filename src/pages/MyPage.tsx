import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { changePassword, getMyAccount, withdrawAccount } from '@/features/auth/api';
import { getMyProfile, updateNickname, withdrawProfile } from '@/features/member/api';
import { errorOf, messageOf } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorBox, Field, Input, Panel } from '@/components/ui';

/**
 * 마이페이지. **한 화면에 두 서비스가 필요하다.**
 *
 * 이메일·가입일은 auth(GET /api/v1/accounts/me)에, 닉네임은 member(GET /api/v1/members/me)에
 * 있다 (api-contract.md §2.2·§3.1). 그리고 **두 "가입일" 이 다른 값이다** — account.created_at
 * 과 member.created_at 은 사이에 로그인이 끼어 같지 않다 (adr/0012 §4).
 *
 * 탈퇴는 2단계이고 **순서를 바꾸지 않는다** — 계정(auth) 다음 프로필(member)이다 (§9.1.1).
 */
export function MyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { accountId, role, clear } = useAuthStore();

  const [nickname, setNickname] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [withdrawPassword, setWithdrawPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);

  const account = useQuery({ queryKey: ['account', 'me'], queryFn: getMyAccount, retry: false });
  const profile = useQuery({ queryKey: ['member', 'me'], queryFn: getMyProfile, retry: false });
  const noProfile = errorOf(profile.error)?.code === 'M001';

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setFields([]);
    setNotice(null);
    try {
      await fn();
      setNotice(`${label} 완료`);
    } catch (e) {
      setError(messageOf(e));
      setFields((errorOf(e)?.fieldErrors ?? []).map((f) => `${f.field}: ${f.message}`));
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-default">마이페이지</h1>

      {notice ? (
        <div className="rounded-md border border-line bg-success-50 px-3 py-2 text-sm text-success-600">
          {notice}
        </div>
      ) : null}
      <ErrorBox message={error} fields={fields} />

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="계정 — auth">
          {account.isError ? (
            <ErrorBox message={messageOf(account.error)} />
          ) : (
            <dl className="space-y-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">이메일</dt>
                <dd className="text-default">{account.data?.email ?? '…'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">계정 생성</dt>
                <dd className="font-mono text-xs text-default">
                  {formatDateTime(account.data?.createdAt)}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">sub / role</dt>
                <dd className="font-mono text-xs text-default">
                  {accountId} / {role}
                </dd>
              </div>
            </dl>
          )}
          <p className="mt-2 text-xs text-faint">
            이 응답에는 accountId 와 nickname 이 없다 — auth 가 소유하지 않는 값이다.
          </p>
        </Panel>

        <Panel title="프로필 — member">
          {noProfile ? (
            <div className="space-y-2 text-sm">
              <p className="text-danger-600">M001 — 프로필이 없다. 오류가 아니라 가입 3단계 미완료다.</p>
              <Link to="/signup/profile" className="text-accent-600 underline">
                프로필 등록하러 가기
              </Link>
            </div>
          ) : profile.isError ? (
            <ErrorBox message={messageOf(profile.error)} />
          ) : (
            <>
              <dl className="space-y-1.5 text-sm">
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted">닉네임</dt>
                  <dd className="text-default">{profile.data?.nickname ?? '…'}</dd>
                </div>
              </dl>
              <form
                className="mt-3 flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('닉네임 수정', async () => {
                    await updateNickname(nickname);
                    setNickname('');
                    await queryClient.invalidateQueries({ queryKey: ['member', 'me'] });
                  });
                }}
              >
                <div className="flex-1">
                  <Field label="새 닉네임">
                    <Input value={nickname} onChange={(e) => setNickname(e.target.value)} />
                  </Field>
                </div>
                <Button type="submit" variant="primary">
                  수정
                </Button>
              </form>
              <p className="mt-2 text-xs text-faint">
                수정해도 토큰이 바뀌지 않는다 — claim 에 nickname 이 없다. 과거 글의 작성자 이름도
                그대로다 (스냅샷, adr/0003).
              </p>
            </>
          )}
        </Panel>

        <Panel title="비밀번호 변경 — auth">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run('비밀번호 변경', async () => {
                await changePassword(currentPassword, newPassword);
                setCurrentPassword('');
                setNewPassword('');
              });
            }}
          >
            <Field label="현재 비밀번호">
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </Field>
            <Field label="새 비밀번호" hint="규칙 위반은 400 C001, fieldErrors 에 newPassword">
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary">
              PATCH /api/v1/accounts/me/password
            </Button>
          </form>
          <p className="mt-2 text-xs text-faint">
            RefreshToken 은 삭제되지만 이미 발급된 Access Token 은 만료까지 통과한다 (30분 +
            스큐 60초, security.md §5.3).
          </p>
        </Panel>

        <Panel title="탈퇴 — 2단계">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run('탈퇴 1단계 (계정)', async () => {
                await withdrawAccount(withdrawPassword);
                setWithdrawPassword('');
              });
            }}
          >
            <Field label="현재 비밀번호" hint="1단계는 비밀번호를 재확인한다">
              <Input
                type="password"
                value={withdrawPassword}
                onChange={(e) => setWithdrawPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="danger">
              1단계 — DELETE /api/v1/accounts/me
            </Button>
          </form>
          <div className="mt-3 border-t border-line-soft pt-3">
            <Button
              variant="danger"
              onClick={() =>
                void run('탈퇴 2단계 (프로필)', async () => {
                  await withdrawProfile();
                })
              }
            >
              2단계 — DELETE /api/v1/members/me
            </Button>
            <p className="mt-2 text-xs text-faint">
              2단계는 1단계에서 쓰던 Access Token 으로 호출한다. 멱등이라 두 번 눌러도 204 다.
            </p>
          </div>
          <div className="mt-3 border-t border-line-soft pt-3">
            <Button
              onClick={() => {
                clear();
                navigate('/login');
              }}
            >
              토큰 비우기 (로컬만)
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
