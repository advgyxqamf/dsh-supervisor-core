/**
 * ============================================================================
 * DSH 通用 UI 组件库 — 统一出口（Barrel）
 * ============================================================================
 * 用法：
 *   import { Button, Badge, Dialog, Input } from "@/framework/ui";
 *
 * 组件命名遵循 shadcn/ui 风格（Radix + CVA + tailwind-merge）。
 * ============================================================================
 */
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
export { Badge, type BadgeProps } from "./badge";
export { Button, type ButtonProps } from "./button";
export { Checkbox, type CheckboxProps } from "./checkbox";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./empty";
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "./field";
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "./input-group";
export { Input } from "./input";
export { Label } from "./label";
export { Progress } from "./progress";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";
export { Separator } from "./separator";
export { Toaster } from "./sonner";
export { Spinner } from "./spinner";
export { Switch } from "./switch";
export { Textarea } from "./textarea";

