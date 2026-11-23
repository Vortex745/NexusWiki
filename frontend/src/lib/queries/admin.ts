import { keepPreviousData, queryOptions } from "@tanstack/react-query"

import {
  fetchAdminOverview,
  fetchAdminUsers,
  type AdminUsersPage,
} from "../adminApi"

export interface AdminUsersParams {
  q?: string
  status: "all" | "active" | "disabled"
  page: number
  pageSize: number
}

export const adminKeys = {
  all: ["admin"] as const,
  overview: () => [...adminKeys.all, "overview"] as const,
  users: (params: AdminUsersParams) => [...adminKeys.all, "users", params] as const,
}

export function adminOverviewQueryOptions() {
  return queryOptions({
    queryKey: adminKeys.overview(),
    queryFn: fetchAdminOverview,
  })
}

export function adminUsersQueryOptions(params: AdminUsersParams) {
  return queryOptions<AdminUsersPage>({
    queryKey: adminKeys.users(params),
    queryFn: () =>
      fetchAdminUsers({
        ...(params.q ? { q: params.q } : {}),
        status: params.status,
        page: params.page,
        pageSize: params.pageSize,
      }),
    placeholderData: keepPreviousData,
  })
}
