import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { changePassword, getMyAccount, withdrawAccount } from '@/features/auth/api';
import { getMyProfile, updateNickname, withdrawProfile } from '@/features/member/api';
import { fieldMessages } from '@/lib/api/client';
import { MY_PROFILE } from '@/lib/api/errorCodes';
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
  const [error, setError] = useState<unknown>(null);

  const account = useQuery({ queryKey: ['account', 'me'], queryFn: getMyAccount, retry: false });
  const profile = useQuery({ queryKey: ['member', 'me'], queryFn: getMyProfile, retry: false });
  // 입력칸 옆에 오류를 그리는 필드 — 닉네임 입력칸은 프로필 조회가 실패하면 그려지지 않는다.
  const inlineFields = ['currentPassword', 'newPassword', 'password', ...(profile.isError ? [] : ['nickname'])];

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(`${label} 완료`);
    } catch (e) {
      setError(e);
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
      <ErrorBox error={error} inlineFields={inlineFields} />

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="계정">
          {account.isError ? (
            <ErrorBox error={account.error} />
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
            <Field
              label="현재 비밀번호"
              hint="1단계는 비밀번호를 재확인한다"
              errors={fieldMessages(error, 'password')}
            >
              <Input
                type="password"
                value={withdrawPassword}
                onChange={(e) => setWithdrawPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="danger">
              1단계 — 계정 탈퇴
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
              2단계 — 프로필 탈퇴
            </Button>
            <p className="mt-2 text-xs text-faint">
              1단계를 마친 뒤 이 화면에서 이어서 누른다. 여러 번 눌러도 된다.
            </p>
          </div>
          <div className="mt-3 border-t border-line-soft pt-3">
            <Button
              onClick={() => {
                clear();
                navigate('/login');
              }}
            >
              이 탭에서만 로그아웃
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
