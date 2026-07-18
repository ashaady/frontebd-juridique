import { SimulationWorkspace } from "../_components/simulation-workspace";

type SimulationPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SimulationPage({ searchParams }: SimulationPageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const rawNewSimulation = resolvedSearchParams.new;
  const forceNewSimulation =
    typeof rawNewSimulation === "string"
      ? ["1", "true", "yes"].includes(rawNewSimulation.toLowerCase())
      : Array.isArray(rawNewSimulation)
        ? rawNewSimulation.some((value) => ["1", "true", "yes"].includes(value.toLowerCase()))
        : false;

  return <SimulationWorkspace forceNewSimulation={forceNewSimulation} />;
}
