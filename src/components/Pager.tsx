import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Page } from '@/lib/api/types';
import { Button } from './ui';

/** 페이징 키는 page·size·totalElements·totalPages·first·last 다 (api-contract.md §7.1). */
export function Pager<T>({ page, onChange }: { page: Page<T>; onChange: (next: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-3 text-sm">
      <Button disabled={page.first} onClick={() => onChange(page.page - 1)}>
        <ChevronLeft size={14} /> 이전
      </Button>
      <span className="font-mono text-xs text-muted">
        {page.page + 1} / {Math.max(page.totalPages, 1)} · 전체 {page.totalElements}건
      </span>
      <Button disabled={page.last} onClick={() => onChange(page.page + 1)}>
        다음 <ChevronRight size={14} />
      </Button>
    </div>
  );
}
