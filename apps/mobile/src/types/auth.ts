export interface AuthUser {
  sub: string;
  email: string;
}

export interface AuthTokens {
  token: string;
}

export interface AuthRegisterResponse {
  id: string;
  email: string;
  approved: boolean;
}
