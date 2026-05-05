import type { AuthUser } from "./middleware/toss-auth";

export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};
