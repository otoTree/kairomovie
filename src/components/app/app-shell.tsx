"use client"

import Link from "next/link"
import { Settings2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AuthUser, clearAuth } from "@/lib/client-auth"

type AppShellProps = {
  user: AuthUser | null
  title: string
  subtitle: string
  children: ReactNode
}

export function AppShell({ user, title, subtitle, children }: AppShellProps) {
  const router = useRouter()

  function handleLogout() {
    clearAuth()
    router.push("/login")
  }

  return (
    <main className="min-h-screen bg-[oklch(1_0_0)] px-6 py-6 text-black">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="rounded-2xl border border-black/6 bg-[oklch(1_0_0)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">{title}</h1>
              <p className="mt-1 text-sm text-black/60">{subtitle}</p>
            </div>
            <div className="flex items-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" className="cursor-pointer" title="设置">
                    <Settings2 />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>快捷入口</DropdownMenuLabel>
                  <DropdownMenuItem asChild>
                    <Link href="/workspace" className="cursor-pointer">
                      画布工作台
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/assets" className="cursor-pointer">
                      资产文件系统
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/settings" className="cursor-pointer">
                      系统设置
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {user ? (
                    <DropdownMenuItem onSelect={handleLogout} variant="destructive">
                      退出登录
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem asChild>
                      <Link href="/login" className="cursor-pointer">
                        前往登录
                      </Link>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>
        {children}
      </div>
    </main>
  )
}
