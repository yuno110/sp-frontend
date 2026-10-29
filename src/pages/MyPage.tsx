import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { changePassword, getMyAccount, withdrawAccount } from '@/features/auth/api';
import { getMyProfile, updateNickname, withdrawProfile } from '@/features/member/api';
import { errorOf, fieldMessages } from '@/lib/api/client';
import { AFTER_WITHDRAWAL, MY_PROFILE } from '@/lib/api/errorCodes';
import { withoutRequestBody } from '@/lib/api/withoutRequestBody';
import { DEV_ONLY } from '@/lib/devOnly';
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
 * 탈퇴는 사용자에게 한 동작이고 화면이 계정(auth) → 프로필(member) 순서로 부른다. **순서를 바꾸지 않는다**(§9.1.1).
 */
export function MyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { accountId, role, withdrawal, setWithdrawal, clear } = useAuthStore();

  const [nickname, setNickname] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [withdrawPassword, setWithdrawPassword] = useState('');
  const [withdrawError, setWithdrawError] = useState<unknown>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const account = useQuery({ queryKey: ['account', 'me'], queryFn: getMyAccount, retry: false });
  const profile = useQuery({ queryKey: ['member', 'me'], queryFn: getMyProfile, retry: false });
  // 입력칸 옆에 오류를 그리는 필드 — 닉네임 입력칸은 프로필 조회가 실패하면 그려지지 않는다. 탈퇴의 오류는 탈퇴 칸이 따로 그린다.
  const inlineFields = ['currentPassword', 'newPassword', ...(profile.isError ? [] : ['nickname'])];

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(`${label} 완료`);
    } catch (e) {
      // 쥐는 것은 요청 본문을 비운 사본이다 — 비밀번호 변경의 본문에는 비밀번호가 있다.
      setError(withoutRequestBody(e));
    }
  };

  /**
   * 탈퇴. 비밀번호를 한 번 받아 계정 탈퇴 → 프로필 탈퇴를 부른다(api-contract.md §9.1.1). 프로필 탈퇴는 계정 탈퇴에서 쓰던
   * Access Token 으로 나간다 — 계정 탈퇴가 Refresh Token 을 지워 재발급되지 않으므로 **토큰은 끝난 뒤에 지운다.**
   *
   * 다시 시도는 첫 단계부터다. 비밀번호도 다시 받는다 — 탈퇴한 계정의 계정 탈퇴는 비밀번호가 틀려도 204 지만 빈 값은
   * `C001` 이다(§2.2).
   */
  const withdraw = async () => {
    setWithdrawing(true);
    setWithdrawError(null);
    try {
      // 첫 단계가 어떤 이유로든 실패하면 둘째를 부르지 않는다.
      await withdrawAccount(withdrawPassword);
      setWithdrawPassword('');
      setWithdrawal('account');
      await withdrawProfile().catch((e: unknown) => {
        // 프로필이 아예 없는 계정이다 — 지울 것이 없으므로 끝난 것이다(§3.1, 그 경우는 멱등의 대상이 아니라 404 다).
        if (errorOf(e)?.code !== 'M001') throw e;
      });
    } catch (e) {
      // 둘째 단계의 실패면 계정 탈퇴는 끝났다(`withdrawal`). 토큰이 남아 있으면 이 칸에서 다시 시도한다. 토큰이 비었으면
      // (A003 뒤 재발급 실패) 이 화면은 로그인으로 가고 로그인 화면이 다시 시도할 수 없다는 것을 보인다. 쥐는 것은 요청
      // 본문을 비운 사본이다 — 계정 탈퇴의 본문에는 비밀번호가 있다.
      setWithdrawError(withoutRequestBody(e));
      return;
    } finally {
      setWithdrawing(false);
    }
    // 로그아웃 요청은 보내지 않는다 — 로그아웃은 저장된 Refresh Token 을 지우는 것인데(requirements/member.md MR-06)
    // 계정 탈퇴가 같은 트랜잭션에서 지웠고, 지울 것이 없어도 204 라(§2.1) 서버에서 바뀌는 것이 없다.
    setWithdrawal('done');
    clear();
    navigate('/login', { replace: true });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-default">마이페이지</h1>

      {notice ? (
        <div className="rounded-md border border-line bg-success-50 px-3 py-2 text-sm text-success-600">
          {notice}
        </div>
      ) : null}
      <ErrorBox error={error} inlineFields={inlineFields} />

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="계정">
          {account.isError ? (
            <ErrorBox error={account.error} />
          ) : (
            <dl className="space-y-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">이메일</dt>
                {/* 이메일은 길 수 있고(sp-docs/requirements/member.md §2) 띄어쓰기가 없다 — 줄을 바꾸지 않으면 좁은 화면에서 가로로
                    스크롤된다(F-05). */}
                <dd className="text-default wrap-anywhere">{account.data?.email ?? '…'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted">계정 생성</dt>
                <dd className="font-mono text-xs text-default">
                  {formatDateTime(account.data?.createdAt)}
                </dd>
              </div>
              {DEV_ONLY ? (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted">sub / role</dt>
                  <dd className="font-mono text-xs text-default">
                    {accountId} / {role}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </Panel>

        <Panel title="프로필">
          {profile.isError ? (
            // 이 조회의 M001 은 "프로필이 아직 없음" 이다 — 프로필 등록으로 안내한다(MY_PROFILE).
            <ErrorBox error={profile.error} meanings={MY_PROFILE} />
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
                  <Field label="새 닉네임" errors={fieldMessages(error, 'nickname')}>
                    <Input value={nickname} onChange={(e) => setNickname(e.target.value)} />
                  </Field>
                </div>
                <Button type="submit" variant="primary">
                  수정
                </Button>
              </form>
              {DEV_ONLY ? (
                <p className="mt-2 text-xs text-faint">
                  수정해도 토큰이 바뀌지 않는다 — claim 에 nickname 이 없다. 과거 글의 작성자 이름도
                  그대로다 (스냅샷, adr/0003).
                </p>
              ) : null}
            </>
          )}
        </Panel>

        <Panel title="비밀번호 변경">
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
            <Field label="현재 비밀번호" errors={fieldMessages(error, 'currentPassword')}>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </Field>
            <Field label="새 비밀번호" errors={fieldMessages(error, 'newPassword')}>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary">
              비밀번호 변경
            </Button>
          </form>
          {DEV_ONLY ? (
            <p className="mt-2 text-xs text-faint">
              RefreshToken 은 삭제되지만 이미 발급된 Access Token 은 만료까지 통과한다 (30분 +
              스큐 60초, security.md §5.3).
            </p>
          ) : null}
        </Panel>

        <Panel title="탈퇴">
          {withdrawal === 'account' ? (
            <p className="mb-3 text-sm text-default">
              계정은 탈퇴했지만 프로필 탈퇴를 마치지 못했습니다. 비밀번호를 다시 입력하고 다시 시도해 주세요. 로그인 상태가
              끝나면 다시 시도할 수 없습니다 — 창을 닫거나 새로고침해도 끝납니다.
            </p>
          ) : null}
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void withdraw();
            }}
          >
            <Field
              label="현재 비밀번호"
              hint="탈퇴하려면 비밀번호를 한 번 더 확인합니다"
              errors={fieldMessages(withdrawError, 'password')}
            >
              <Input
                type="password"
                value={withdrawPassword}
                onChange={(e) => setWithdrawPassword(e.target.value)}
              />
            </Field>
            {/* 계정 탈퇴가 끝난 뒤의 실패는 다시 로그인하라고 하지 않는다 — 탈퇴한 계정은 로그인할 수 없다(AFTER_WITHDRAWAL). */}
            <ErrorBox
              error={withdrawError}
              inlineFields={['password']}
              meanings={withdrawal === 'account' ? AFTER_WITHDRAWAL : undefined}
            />
            <Button type="submit" variant="danger" disabled={withdrawing}>
              {withdrawal === 'account' ? '다시 시도' : '탈퇴'}
            </Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}
