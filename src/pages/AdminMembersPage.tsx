import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import {
  ACCOUNT_EMAIL_FILTER_MAX,
  listAccounts,
  type AccountRole,
  type AccountSort,
  type AccountSummary,
} from '@/features/auth/api';
import { getProfiles, type PublicProfile } from '@/features/member/api';
import { ADMIN_ONLY } from '@/lib/api/errorCodes';
import { formatDateTime } from '@/lib/format';
import { Button, Empty, ErrorBox } from '@/components/ui';
import { Pager } from '@/components/Pager';

/**
 * 한 페이지의 계정 수 — 계정 목록의 기본값이다(sp-docs/api-contract.md §2.5). 프로필 일괄 조회는 이 페이지의 id 를 한 번에 받으므로
 * 그 상한(50, §3.2) 안이어야 한다. 서버도 계정 목록의 `size` 를 50 에서 자르므로 한 페이지가 그 상한을 넘지 않는다.
 */
export const ADMIN_MEMBERS_PAGE_SIZE = 20;

const SORT_LABEL: Record<AccountSort, string> = { latest: '가입 최신순', email: '이메일순' };
const ROLE_LABEL: Record<AccountRole, string> = { ADMIN: '관리자', USER: '일반' };

/** 셀렉트의 값 — 빈 문자열은 그 조건을 보내지 않는다. */
type RoleFilter = '' | AccountRole;
type DeletedFilter = '' | 'active' | 'deleted';

/**
 * 한 계정의 프로필 칸. 일괄 조회를 받는 중·받지 못함·결과에 없음(프로필 없음)·받음 넷을 가른다. **받지 못함을 「프로필 없음」 으로 그리지
 * 않는다** — 실패를 빈 결과처럼 다루면 실패를 숨긴다(AGENTS.md 불변식 9).
 */
type ProfileCell = { kind: 'loading' } | { kind: 'failed' } | { kind: 'none' } | { kind: 'profile'; profile: PublicProfile };

function ProfileText({ cell }: { cell: ProfileCell }) {
  switch (cell.kind) {
    case 'loading':
      return <span className="text-faint">…</span>;
    case 'failed':
      return <span className="text-danger-600">불러오지 못함</span>;
    case 'none':
      return <span className="text-faint">프로필 없음</span>;
    case 'profile':
      return (
        <span className="wrap-anywhere">
          <span className="text-default">{cell.profile.nickname}</span>
          {cell.profile.deleted ? <span className="ml-1.5 text-xs text-muted">(프로필 탈퇴)</span> : null}
        </span>
      );
  }
}

function Badge({ tone, children }: { tone: 'accent' | 'danger' | 'plain'; children: string }) {
  const color =
    tone === 'accent'
      ? 'bg-accent-50 text-accent-700'
      : tone === 'danger'
        ? 'bg-danger-50 text-danger-600'
        : 'border border-line text-muted';
  return <span className={`whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs font-medium ${color}`}>{children}</span>;
}

/** 계정의 상태 — 인증 여부·잠김·탈퇴(§2.5 의 `emailVerified`·`locked`·`deleted`). 정상인 값은 배지를 붙이지 않고 인증만 둘 다 보인다. */
function AccountStatus({ account }: { account: AccountSummary }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {account.emailVerified ? <Badge tone="plain">인증됨</Badge> : <Badge tone="accent">미인증</Badge>}
      {account.locked ? <Badge tone="danger">잠김</Badge> : null}
      {account.deleted ? <Badge tone="danger">탈퇴</Badge> : null}
    </span>
  );
}

/**
 * 관리자 회원 목록 (sp-docs/requirements/member.md §13, plan/phase2-frontend-integration.md F-11).
 *
 * 계정 한 페이지를 받고(`GET /api/v1/accounts`, §2.5) 그 페이지의 id 로 프로필을 **한 번에** 받아(`GET /api/v1/members?accountIds=`,
 * §3.2) `accountId` 로 합친다 — 계정마다 부르지 않는다. **페이지가 비면 일괄 조회를 부르지 않는다** — `accountIds` 누락은 400 `C001`
 * 이다. 일괄 결과에 없는 계정은 목록에서 빼지 않고 「프로필 없음」 으로 그린다. 두 조회는 다른 시점의 값이다(member.md §13) — 관리 화면의
 * 표시로 받아들인다.
 *
 * ADMIN 판정은 두 서비스가 한다 — 아니면 403 `A004` 이고 이 화면은 그것을 오류 상자로 보인다(security.md §5.1). 머리글 링크를 ADMIN 에게만
 * 그리는 것은 편의다(components/Layout.tsx).
 */
export function AdminMembersPage() {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<AccountSort>('latest');
  const [role, setRole] = useState<RoleFilter>('');
  const [deleted, setDeleted] = useState<DeletedFilter>('');
  const [email, setEmail] = useState('');
  const [applied, setApplied] = useState('');

  const accounts = useQuery({
    queryKey: ['admin', 'accounts', { page, sort, role, deleted, applied }],
    queryFn: () =>
      listAccounts({
        page,
        size: ADMIN_MEMBERS_PAGE_SIZE,
        sort,
        email: applied,
        role: role || undefined,
        deleted: deleted === '' ? undefined : deleted === 'deleted',
      }),
    retry: false,
  });

  const ids = accounts.data?.content.map((account) => account.id) ?? [];
  const profiles = useQuery({
    queryKey: ['admin', 'members', ids],
    queryFn: () => getProfiles(ids),
    retry: false,
    // 빈 페이지에는 물을 id 가 없다 — 비운 `accountIds` 는 400 C001 이다(§3.2).
    enabled: ids.length > 0,
  });

  const byId = new Map((profiles.data?.members ?? []).map((profile) => [profile.accountId, profile]));
  const cellOf = (accountId: number): ProfileCell => {
    if (profiles.isError) return { kind: 'failed' };
    if (!profiles.data) return { kind: 'loading' };
    const profile = byId.get(accountId);
    return profile ? { kind: 'profile', profile } : { kind: 'none' };
  };

  const apply = () => {
    setApplied(email.trim());
    setPage(0);
  };
  const filtered = applied.trim() !== '' || role !== '' || deleted !== '';
  const rows = accounts.data?.content ?? [];

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold text-default">회원 목록</h1>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-subtle px-3 py-2.5">
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as AccountSort);
            setPage(0);
          }}
          aria-label="정렬"
          className="rounded-md border border-line bg-elev px-2 py-1.5 text-sm"
        >
          {(Object.keys(SORT_LABEL) as AccountSort[]).map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          value={role}
          onChange={(e) => {
            setRole(e.target.value as RoleFilter);
            setPage(0);
          }}
          aria-label="역할"
          className="rounded-md border border-line bg-elev px-2 py-1.5 text-sm"
        >
          <option value="">모든 역할</option>
          {(Object.keys(ROLE_LABEL) as AccountRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <select
          value={deleted}
          onChange={(e) => {
            setDeleted(e.target.value as DeletedFilter);
            setPage(0);
          }}
          aria-label="탈퇴 여부"
          className="rounded-md border border-line bg-elev px-2 py-1.5 text-sm"
        >
          <option value="">탈퇴 포함</option>
          <option value="active">탈퇴 제외</option>
          <option value="deleted">탈퇴만</option>
        </select>
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
            maxLength={ACCOUNT_EMAIL_FILTER_MAX}
            placeholder="이메일 (부분 일치)"
            aria-label="이메일 검색어"
            className="rounded-md border border-line bg-elev py-1.5 pl-7 pr-3 text-sm"
          />
        </div>
        <Button onClick={apply}>검색</Button>
        {applied.trim() ? <span className="text-xs text-faint wrap-anywhere">적용: {applied.trim()}</span> : null}
      </div>

      {accounts.isError ? <ErrorBox error={accounts.error} meanings={ADMIN_ONLY} /> : null}

      {/* 일괄 조회의 실패 — 계정 줄은 그대로 두고 닉네임 칸을 「불러오지 못함」 으로 그린다. 「프로필 없음」 이 아니다. */}
      {profiles.isError ? (
        <div className="space-y-1.5">
          <p className="text-sm text-danger-600">닉네임을 불러오지 못했습니다.</p>
          <ErrorBox error={profiles.error} meanings={ADMIN_ONLY} />
        </div>
      ) : null}

      {accounts.isLoading ? (
        <Empty>불러오는 중…</Empty>
      ) : rows.length > 0 ? (
        <>
          <table className="hidden w-full border-collapse overflow-hidden rounded-md border border-line bg-elev text-sm md:table">
            <thead>
              <tr className="border-b border-line bg-subtle text-left text-xs text-muted">
                <th className="hidden w-16 px-3 py-2 text-center lg:table-cell">번호</th>
                <th className="px-3 py-2">이메일</th>
                <th className="w-36 px-3 py-2">닉네임</th>
                <th className="w-16 px-3 py-2">역할</th>
                <th className="w-36 px-3 py-2">상태</th>
                <th className="w-40 px-3 py-2">가입일</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((account) => (
                <tr key={account.id} className="border-b border-line-soft last:border-0">
                  <td className="hidden px-3 py-2 text-center font-mono text-xs text-faint lg:table-cell">{account.id}</td>
                  <td className="px-3 py-2 text-default wrap-anywhere">{account.email}</td>
                  <td className="px-3 py-2">
                    <ProfileText cell={cellOf(account.id)} />
                  </td>
                  <td className="px-3 py-2 text-muted">{ROLE_LABEL[account.role] ?? account.role}</td>
                  <td className="px-3 py-2">
                    <AccountStatus account={account} />
                  </td>
                  <td className="px-3 py-2 text-muted">{formatDateTime(account.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="divide-y divide-[var(--color-line-soft)] rounded-md border border-line bg-elev text-sm md:hidden">
            {rows.map((account) => (
              <li key={account.id} className="space-y-1 px-3 py-2.5">
                <p className="text-default wrap-anywhere">{account.email}</p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <ProfileText cell={cellOf(account.id)} />
                  <span>{ROLE_LABEL[account.role] ?? account.role}</span>
                  <AccountStatus account={account} />
                  <span>가입 {formatDateTime(account.createdAt)}</span>
                </p>
              </li>
            ))}
          </ul>
          {accounts.data ? <Pager page={accounts.data} onChange={setPage} /> : null}
        </>
      ) : accounts.data ? (
        <Empty>{filtered ? '조건에 맞는 계정이 없습니다' : '계정이 없습니다'}</Empty>
      ) : null}
    </div>
  );
}
