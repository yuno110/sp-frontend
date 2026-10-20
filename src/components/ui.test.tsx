import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorBox } from './ui';

/**
 * 에러 표시가 서버의 답을 **버리지 않는지**를 잠근다.
 *
 * `C001` 의 본체는 `fieldErrors` 다(api-contract.md §2.3·§4.1). 그것을 떨어뜨리면
 * 화면에 "잘못된 입력값입니다" 한 줄만 남아 무엇이 틀렸는지 알 수 없다 —
 * `AGENTS.md` 불변식 9가 금지하는 실패 은폐다.
 */
describe('ErrorBox', () => {
  it('코드와 메시지를 그대로 보여준다', () => {
    render(<ErrorBox message="AU002 이미 사용 중인 이메일입니다." />);
    expect(screen.getByText('AU002 이미 사용 중인 이메일입니다.')).toBeInTheDocument();
  });

  it('fieldErrors 를 한 건도 빠뜨리지 않는다', () => {
    render(
      <ErrorBox
        message="C001 잘못된 입력값입니다."
        fields={['email: 이메일 형식이 아닙니다.', 'password: 8자 이상이어야 합니다.']}
      />,
    );
    expect(screen.getByText('email: 이메일 형식이 아닙니다.')).toBeInTheDocument();
    expect(screen.getByText('password: 8자 이상이어야 합니다.')).toBeInTheDocument();
  });

  it('fieldErrors 가 빈 배열이면 목록을 그리지 않는다 — 요청 수준 오류가 그렇다', () => {
    const { container } = render(<ErrorBox message="C001 잘못된 입력값입니다." fields={[]} />);
    expect(container.querySelector('ul')).toBeNull();
  });

  it('메시지가 없으면 아무것도 렌더하지 않는다', () => {
    const { container } = render(<ErrorBox message={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
