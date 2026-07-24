import { redirect } from "next/navigation";

/** `/` lands on the Fleet dashboard (master plan §3, §7.1). */
export default function Home(): never {
  redirect("/fleet");
}
