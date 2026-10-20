import { create } from 'zustand';
import type { ServiceName } from '@/lib/api/services';

/**
 * 최근 요청 기록. 화면 하단 패널이 이걸 보여준다.
 *
 * 이 저장소의 목적이 "세 서비스가 엮여 도는지 눈으로 보는 것" 이므로, **어느 서비스가
 * 무엇을 답했는지**가 화면에 남아야 한다. 코드·fieldErrors 를 가공하지 않고 그대로 담는다.
 */
export interface ApiLogEntry {
  id: number;
  at: string;
  method: string;
  path: string;
  service: ServiceName | null;
  status: number | null;
  code: string | null;
  message: string | null;
  fields: string[];
  ms: number;
  /** 네트워크 단계에서 끊긴 경우(CORS 거부·연결 거부·타임아웃). 응답이 없다. */
  transportError: string | null;
}

interface ApiLogState {
  entries: ApiLogEntry[];
  push: (e: Omit<ApiLogEntry, 'id' | 'at'>) => void;
  clear: () => void;
}

const LIMIT = 50;
let seq = 0;

export const useApiLogStore = create<ApiLogState>((set) => ({
  entries: [],
  push: (e) =>
    set((s) => ({
      entries: [
        { ...e, id: ++seq, at: new Date().toLocaleTimeString('ko-KR', { hour12: false }) },
        ...s.entries,
      ].slice(0, LIMIT),
    })),
  clear: () => set({ entries: [] }),
}));
