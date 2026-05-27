"use client";
import { Brain, LogOut, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/store/auth";
import { NavLink } from "@/components/NavLink";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { NAV_GROUPS, findActiveGroup } from "@/components/nav-groups";
import { cn } from "@/lib/utils";

export function AppSidebar() {
  const { state, setOpenMobile, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const isMobile = useIsMobile();
  const showText = isMobile || !collapsed;
  const pathname = usePathname() || "/";
  const activeGroup = findActiveGroup(pathname);

  const { user, clear } = useAuth();
  const router = useRouter();

  const userEmail = user?.email || "user@unknown";
  const userName = user?.full_name || userEmail.split("@")[0];
  const initials = userName.slice(0, 2).toUpperCase();
  const visibleGroups = NAV_GROUPS.filter((g) => !g.adminOnly || user?.role === "ADMIN");

  const handleNavClick = () => {
    if (isMobile) setOpenMobile(false);
  };

  const handleLogout = () => {
    clear();
    router.push("/login");
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <div className="p-4 flex items-center gap-3 border-b border-sidebar-border">

          {/* <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0"> */}
          <div
            className={cn(
            "w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0 transition-all duration-300",
            collapsed ? "px-2 py-2 ml-[-5px]" : "px-2 py-2"
          )}
          >
            <Brain className="w-5 h-5 text-primary-foreground" />
          </div>


          {showText && (
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-bold tracking-tight text-sidebar-foreground">AlgoTrade</h1>
              <p className="text-[9px] uppercase tracking-[0.15em] text-muted-foreground">Indian Markets</p>
            </div>
          )}
        </div>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {visibleGroups.map((g) => {
                const isActive = activeGroup?.id === g.id;
                return (
                  <SidebarMenuItem key={g.id}>
                    <SidebarMenuButton asChild tooltip={collapsed ? g.title : undefined} isActive={isActive}>
                      <NavLink
                        to={g.defaultHref}
                        className={
                          isActive
                            ? "bg-sidebar-accent text-primary font-medium"
                            : "hover:bg-sidebar-accent/50"
                        }
                        onClick={handleNavClick}
                      >
                        <g.icon className="mr-2 h-4 w-4" />
                        {showText && <span>{g.title}</span>}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <Separator className="mb-2" />
        {/* <div className="flex items-center gap-3 px-0.5 py-2"> */}
        <div
            className={cn(
            "flex items-center gap-3 transition-all duration-300",
            collapsed ? "px-0 py-2 ml-[-2px]" : "px-2 py-2"
          )}
          >
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">
              {initials}
            </AvatarFallback>
          </Avatar>
          {showText && (
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-sidebar-foreground truncate capitalize">{userName}</p>
              <p className="text-[10px] text-muted-foreground truncate">{userEmail}</p>
            </div>
          )}
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 w-full px-2 py-2 rounded-md text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {showText && <span>Logout</span>}
        </button>
        {/* Desktop collapse/expand toggle pinned to the bottom of the
            sidebar. Mobile uses the Sheet backdrop / Header trigger. */}
        {!isMobile && (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand (Ctrl+B)" : "Collapse (Ctrl+B)"}
            className={
              collapsed
                ? "mt-1 flex items-center justify-center w-full px-2 py-2 rounded-md text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                : "mt-1 flex items-center gap-2 w-full px-2 py-2 rounded-md text-xs font-medium text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
            }
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4 shrink-0" />
            ) : (
              <>
                <ChevronsLeft className="h-4 w-4 shrink-0" />
                <span>Collapse</span>
              </>
            )}
          </button>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
