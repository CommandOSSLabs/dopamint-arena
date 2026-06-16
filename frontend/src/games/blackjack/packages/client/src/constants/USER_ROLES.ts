import { UserRole } from "../types/Authentication";

interface IUserRoles {
  ROLE_1: UserRole;
  ROLE_2: UserRole;
  ROLE_3: UserRole;
  ROLE_4: UserRole;
}

export const USER_ROLES: IUserRoles = {
  ROLE_1: "admin",
  ROLE_2: "dealer",
  ROLE_3: "player",
  ROLE_4: "anonymous",
};
