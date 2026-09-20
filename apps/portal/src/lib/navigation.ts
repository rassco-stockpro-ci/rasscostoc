import {
  Home,
  Boxes,
  Shapes,
  Search,
  ClipboardList,
  Warehouse,
  Undo2,
  Calculator,
  Users,
  ScrollText,
  ShieldCheck,
  Truck,
  LayoutDashboard,
  FileText,
  Database,
  ClipboardCheck,
  BarChart3,
  Download,
  BrainCircuit,
  History,
  Settings,
  Activity,
  QrCode,
  Key,
  Lock,
  type LucideIcon
} from "lucide-react";
import { ROLES } from "@shared/roles";

export interface NavigationItem {
  id: string;
  href: string;
  /** i18n key under common.nav.* (e.g. "nav.home") */
  labelKey: string;
  icon: LucideIcon;
  roles: string[];
  children?: {
    id: string;
    href: string;
    labelKey: string;
    icon: LucideIcon;
    roles?: string[];
  }[];
}

/** @deprecated use labelKey — kept for gradual migration */
export type NavigationItemLegacy = NavigationItem & { label?: string };

export const navigationRegistry: NavigationItem[] = [
  {
    id: "home",
    href: "/home",
    labelKey: "nav.home",
    icon: Home,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.TECHNICIAN]
  },
  {
    id: "verification",
    href: "/verification",
    labelKey: "nav.verification",
    icon: QrCode,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  },
  {
    id: "courier",
    href: "/courier",
    labelKey: "nav.courier",
    icon: Truck,
    roles: [ROLES.ADMIN],
    children: [
      {
        id: "courier-dashboard",
        href: "/courier",
        labelKey: "nav.courier-dashboard",
        icon: LayoutDashboard,
        roles: [ROLES.ADMIN]
      },
      {
        id: "courier-ai-monitor",
        href: "/courier/ai-monitor",
        labelKey: "nav.courier-ai-monitor",
        icon: BrainCircuit,
        roles: [ROLES.ADMIN]
      },
      {
        id: "courier-observability",
        href: "/courier/observability",
        labelKey: "nav.courier-observability",
        icon: Activity,
        roles: [ROLES.ADMIN]
      },
      {
        id: "courier-audit-log",
        href: "/courier/audit-log",
        labelKey: "nav.courier-audit-log",
        icon: History,
        roles: [ROLES.ADMIN]
      },
      {
        id: "courier-settings",
        href: "/courier/settings",
        labelKey: "nav.courier-settings",
        icon: Settings,
        roles: [ROLES.ADMIN]
      }
    ]
  },
  {
    id: "inventory",
    href: "/admin-inventory-overview",
    labelKey: "nav.inventory",
    icon: Boxes,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  },
  {
    id: "my-inventory",
    href: "/my-fixed-inventory",
    labelKey: "nav.my-inventory",
    icon: Boxes,
    roles: [ROLES.TECHNICIAN]
  },
  {
    id: "products",
    href: "/products-management",
    labelKey: "nav.products",
    icon: Shapes,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.TECHNICIAN]
  },
  {
    id: "search",
    href: "/operations-search",
    labelKey: "nav.search",
    icon: Search,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.TECHNICIAN]
  },
  {
    id: "operations",
    href: "/operations",
    labelKey: "nav.operations",
    icon: ClipboardList,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  },
  {
    id: "warehouses",
    href: "/warehouses",
    labelKey: "nav.warehouses",
    icon: Warehouse,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  },
  {
    id: "withdrawn",
    href: "/withdrawn-devices",
    labelKey: "nav.withdrawn",
    icon: Undo2,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  },
  {
    id: "accounting",
    href: "/accounting",
    labelKey: "nav.accounting",
    icon: Calculator,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  },
  {
    id: "logs",
    href: "/system-logs",
    labelKey: "nav.logs",
    icon: ScrollText,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  },
  {
    id: "backup",
    href: "/backup",
    labelKey: "nav.backup",
    icon: ShieldCheck,
    roles: [ROLES.ADMIN]
  },
  {
    id: "item-types",
    href: "/item-types",
    labelKey: "nav.item-types",
    icon: Shapes,
    roles: [ROLES.ADMIN]
  },
  {
    id: "ai-engine-settings",
    href: "/ai-engine/settings",
    labelKey: "nav.ai-engine-settings",
    icon: BrainCircuit,
    roles: [ROLES.ADMIN]
  },
  {
    id: "permissions-center",
    href: "/admin/permissions",
    labelKey: "nav.permissions-center",
    icon: Lock,
    roles: [ROLES.ADMIN]
  },
  {
    id: "leads-audit",
    href: "/leads-audit",
    labelKey: "nav.leads-audit",
    icon: Key,
    roles: [ROLES.ADMIN, ROLES.SUPERVISOR]
  }
];

/**
 * Filter the registry to retrieve items authorized for the user's role
 */
export function getAuthorizedNavigation(userRole: string): NavigationItem[] {
  return navigationRegistry.filter(item => item.roles.includes(userRole));
}
