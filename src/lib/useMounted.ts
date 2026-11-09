import { useEffect, useRef } from 'react';

/**
 * 이 화면이 아직 떠 있는가. 요청을 기다린 뒤에 화면을 옮기는 자리가 본다 — 내려간 화면의 `navigate` 도 라우터를 움직이므로, 보지 않으면 늦은
 * 응답이 이미 떠난 사용자를 끌어간다. 효과로 켜고 끄므로 StrictMode 가 효과를 두 번 돌려도 맞다.
 */
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
