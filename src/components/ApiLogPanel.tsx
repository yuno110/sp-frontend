import { useState } from 'react';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useApiLogStore } from '@/stores/apiLogStore';
import { describeCode } from '@/lib/api/errorCodes';
import { apiMode, serviceBaseUrls } from '@/lib/api/services';

const SERVICE_TAG: Record<string, string> = {
  auth: 'bg-accent-50 text-accent-700',
  member: 'bg-success-50 text-success-600',
  board: 'bg-warn-50 text-warn-600',
};

/**
 * 요청 기록 패널. 이 저장소의 목적이 "세 서비스가 엮여 도는지 보는 것" 이므로
 * 어느 서비스가 어떤 코드로 답했는지를 화면 아래에 상주시킨다.
 */
export function ApiLogPanel() {
  const [open, setOpen] = useState(true);
  const entries = useApiLogStore((s) => s.entries);
  const clear = useApiLogStore((s) => s.clear);

  return (
    <aside className="border-t border-line bg-elev">
      <header className="flex items-center gap-3 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-sm font-semibold text-default"
        >
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          요청 기록 <span className="text-faint">({entries.length})</span>
        </button>
        <span className="text-xs text-faint">
          {apiMode === 'direct'
            ? `직접 호출 — auth ${serviceBaseUrls.auth} · member ${serviceBaseUrls.member} · board ${serviceBaseUrls.board}`
            : 'Vite 프록시 경유 (같은 오리진 — CORS preflight 가 날아가지 않는다)'}
        </span>
        <button
          type="button"
          onClick={clear}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-default"
        >
          <Trash2 size={12} /> 비우기
        </button>
      </header>

      {open ? (
        <div className="max-h-56 overflow-auto border-t border-line-soft">
          {entries.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-faint">아직 요청이 없다</div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <tbody>
                {entries.map((e) => {
                  const info = describeCode(e.code);
                  return (
                    <tr key={e.id} className="border-b border-line-soft align-top">
                      <td className="w-20 px-3 py-1.5 font-mono text-faint">{e.at}</td>
                      <td className="w-16 px-1 py-1.5">
                        {e.service ? (
                          <span className={clsx('rounded px-1.5 py-0.5 font-medium', SERVICE_TAG[e.service])}>
                            {e.service}
                          </span>
                        ) : null}
                      </td>
                      <td className="w-16 px-1 py-1.5 font-mono text-muted">{e.method}</td>
                      <td className="px-1 py-1.5 font-mono text-default">{e.path}</td>
                      <td className="w-14 px-1 py-1.5 text-right font-mono text-muted">{e.ms}ms</td>
                      <td className="w-14 px-1 py-1.5 text-right font-mono">
                        {e.status === null ? (
                          <span className="text-danger-600">—</span>
                        ) : (
                          <span className={e.status >= 400 ? 'text-danger-600' : 'text-success-600'}>
                            {e.status}
                          </span>
                        )}
                      </td>
                      <td className="w-[38%] px-3 py-1.5">
                        {e.transportError ? (
                          <span className="text-danger-600">
                            응답 없음 — {e.transportError} (서비스 기동·CORS 오리진을 본다)
                          </span>
                        ) : e.code ? (
                          <span>
                            <span className="font-mono font-semibold text-danger-600">{e.code}</span>{' '}
                            <span className="text-default">{e.message}</span>
                            {info ? <span className="text-faint"> · {info.owner} · {info.note}</span> : null}
                            {e.fields.length > 0 ? (
                              <span className="text-faint"> · {e.fields.join(', ')}</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-faint">성공</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </aside>
  );
}
