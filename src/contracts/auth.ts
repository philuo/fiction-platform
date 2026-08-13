export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
};

export type RequestContext = {
  userId: number;
  username: string;
};
