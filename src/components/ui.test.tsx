import { render, screen, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ERROR_SENTENCES, MY_PROFILE, UNEXPECTED } from '@/lib/api/errorCodes';
import { ErrorBox, ErrorLine, Field, Input } from './ui';

/**
 * 에러 표시가 서버의 답을 **버리지 않는지**를 잠근다.
 *
 * `C001` 의 본체는 `fieldErrors` 다(api-contract.md §2.3·§4.1). 그것을 떨어뜨리면
 * 화면에 "잘못된 입력값입니다" 한 줄만 남아 무엇이 틀렸는지 알 수 없다 —
 * `AGENTS.md` 불변식 9가 금지하는 실패 은폐다. 문장은 사용자 말로 다듬되(F-03) 코드는 남긴다.
 */

/** 서버가 오류 본문을 실어 보낸 실패. 인터셉터를 지난 뒤 화면이 받는 모양이다. */
function apiError(status: number, code: string, message: string, fieldErrors: Array<{ field: string; message: string }> = []) {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const response = {
    data: { success: false, data: null, error: { code, message, fieldErrors } },
    status,
    statusText: '',
    headers: {},
    config,
  } as AxiosResponse;
  return new AxiosError(`status ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
}

/** 코드 자리. 있는 것만이 아니라 보이는지까지 단언한다 — `hidden` 으로 숨긴 코드는 버린 것과 같다. */
const code = (container: HTMLElement) => {
  const el = container.querySelector('[data-error-code]');
  expect(el).toBeVisible();
  return el;
};

describe('ErrorBox', () => {
  it('사전에 있는 코드 — 사용자 문장을 보여주고 코드를 보조 정보로 남긴다', () => {
    const { container } = render(<ErrorBox error={apiError(409, 'AU002', '이미 사용 중인 이메일입니다.')} />);
    expect(screen.getByText(ERROR_SENTENCES.AU002.text)).toBeInTheDocument();
    expect(code(container)).toHaveTextContent(/^AU002$/);
  });

  it('사전에 없는 코드 — 서버 메시지와 코드를 그대로 보여준다', () => {
    const { container } = render(<ErrorBox error={apiError(400, 'X999', '새로 생긴 오류입니다.')} />);
    expect(screen.getByText('새로 생긴 오류입니다.')).toBeInTheDocument();
    expect(code(container)).toHaveTextContent(/^X999$/);
  });

  it('fieldErrors 를 한 건도 빠뜨리지 않는다', () => {
    render(
      <ErrorBox
        error={apiError(400, 'C001', '잘못된 입력값입니다.', [
          { field: 'email', message: '올바른 이메일 형식이 아닙니다.' },
          { field: 'password', message: '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.' },
        ])}
      />,
    );
    expect(screen.getByText('올바른 이메일 형식이 아닙니다.')).toBeInTheDocument();
    expect(screen.getByText('비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.')).toBeInTheDocument();
  });

  it('입력칸 옆에 그리는 필드만 요약에서 빠진다', () => {
    render(
      <ErrorBox
        error={apiError(400, 'C001', '잘못된 입력값입니다.', [
          { field: 'title', message: '제목은 1~200자여야 합니다.' },
          { field: 'tags', message: '태그는 받지 않습니다.' },
        ])}
        inlineFields={['title']}
      />,
    );
    expect(screen.queryByText('제목은 1~200자여야 합니다.')).toBeNull();
    expect(screen.getByText('태그는 받지 않습니다.')).toBeInTheDocument();
  });

  it('fieldErrors 가 빈 배열이면 목록을 그리지 않는다 — 요청 수준 오류가 그렇다', () => {
    const { container } = render(<ErrorBox error={apiError(400, 'C001', '잘못된 입력값입니다.')} />);
    expect(container.querySelector('ul')).toBeNull();
  });

  it('오류가 없으면 아무것도 렌더하지 않는다', () => {
    const { container } = render(<ErrorBox error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('복구 동작이 있으면 그곳으로 가는 링크를 붙인다 — 넘긴 뜻을 따른다', () => {
    render(
      <MemoryRouter>
        <ErrorBox error={apiError(404, 'M001', '프로필을 찾을 수 없습니다.')} meanings={MY_PROFILE} />
      </MemoryRouter>,
    );
    expect(screen.getByText(MY_PROFILE.M001.text)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '프로필 등록하기' })).toHaveAttribute('href', '/signup/profile');
  });

  it('오류 응답의 모양이 아닌 실패 — 사용자 문장을 보이고, 원문은 개발 빌드에서만 그린다', () => {
    render(<ErrorBox error={new Error('계약 위반 응답: success=true, data=null')} />);
    expect(screen.getByText(UNEXPECTED)).toBeInTheDocument();
    // 이 테스트는 개발 모드로 돈다. 프로덕션 모드에서 빠지는 것은 src/pages/userCopy.test.tsx 가 본다.
    expect(screen.getByText('계약 위반 응답: success=true, data=null')).toBeInTheDocument();
  });
});

describe('ErrorLine', () => {
  it('문장·필드 오류·복구 링크·코드를 한 줄에 담는다', () => {
    const { container } = render(
      <MemoryRouter>
        <ErrorLine
          error={apiError(401, 'A002', '유효하지 않은 토큰입니다.', [{ field: 'x', message: '필드 오류' }])}
        />
      </MemoryRouter>,
    );
    expect(container).toHaveTextContent(ERROR_SENTENCES.A002.text);
    expect(container).toHaveTextContent('필드 오류');
    expect(screen.getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login');
    expect(code(container)).toHaveTextContent(/^A002$/);
  });
});

describe('Field', () => {
  it('그 필드의 오류를 입력칸과 같은 필드 안에 그린다', () => {
    render(
      <Field label="제목" errors={['제목은 1~200자여야 합니다.']}>
        <Input />
      </Field>,
    );
    const field = screen.getByLabelText('제목').closest('label')!.parentElement!;
    expect(within(field).getByText('제목은 1~200자여야 합니다.')).toBeInTheDocument();
  });
});
