import { PrismaClient } from "@prisma/client";

/**
 * Seeds a 500-page tenant for load testing.
 *
 * Run with:
 *   corepack pnpm --filter @staticforge/database db:seed:scale
 *
 * ## Why one business and not several
 *
 * A page slug is `service slug + city`; the business is deliberately not part
 * of it. Two businesses covering the same service in the same city would
 * therefore produce the same slug, and the generator refuses that — correctly,
 * since it would mean two pages fighting for one URL. Five hundred *pages*
 * consequently needs five hundred distinct service-and-city pairs, which is
 * what 20 services × 25 cities gives.
 *
 * Multiple businesses are a multi-*project* shape, not a multi-business page
 * grid: each gets its own project and its own slug space. The database model
 * already reflects that — Business is 1:1 with Project.
 *
 * ## Idempotent
 *
 * Every write is an upsert keyed on a natural unique constraint, so the script
 * is safe to re-run. Ids are derived from the index rather than generated, so a
 * second run updates the same 545 rows instead of creating a second set.
 */

const prisma = new PrismaClient({ log: ["error"] });

const SERVICE_COUNT = 20;
const CITY_COUNT = 25;

const WORKSPACE = {
  id: "ws-scale",
  name: "Scale Test Workspace",
  slug: "scale-test",
} as const;

const PROJECT = {
  id: "prj-scale-500",
  name: "Scale Test — 500 pages",
  slug: "scale-500",
  description: "Synthetic tenant for load testing. Not real data.",
  locale: "de",
  templateId: "default",
  siteUrl: "https://scale.example",
} as const;

/** German service names, enough to reach the service count. */
const SERVICE_NAMES = [
  "Bueroreinigung",
  "Grundreinigung",
  "Treppenhausreinigung",
  "Fensterreinigung",
  "Teppichreinigung",
  "Bauschlussreinigung",
  "Industriereinigung",
  "Praxisreinigung",
  "Hotelreinigung",
  "Schulreinigung",
  "Fassadenreinigung",
  "Solarreinigung",
  "Kuechenreinigung",
  "Sanitaerreinigung",
  "Parkhausreinigung",
  "Gartenpflege",
  "Winterdienst",
  "Hausmeisterservice",
  "Entruempelung",
  "Desinfektion",
] as const;

/** Cities across North Rhine-Westphalia, enough to reach the city count. */
const CITIES = [
  ["Duisburg", "47051"],
  ["Essen", "45127"],
  ["Duesseldorf", "40213"],
  ["Dortmund", "44135"],
  ["Bochum", "44787"],
  ["Wuppertal", "42103"],
  ["Bielefeld", "33602"],
  ["Bonn", "53111"],
  ["Muenster", "48143"],
  ["Moenchengladbach", "41061"],
  ["Gelsenkirchen", "45879"],
  ["Aachen", "52062"],
  ["Krefeld", "47798"],
  ["Oberhausen", "46045"],
  ["Hagen", "58095"],
  ["Hamm", "59065"],
  ["Muelheim", "45468"],
  ["Leverkusen", "51373"],
  ["Solingen", "42651"],
  ["Herne", "44623"],
  ["Neuss", "41460"],
  ["Paderborn", "33098"],
  ["Bottrop", "46236"],
  ["Recklinghausen", "45657"],
  ["Remscheid", "42853"],
] as const;

/** A description long enough to satisfy `ServiceSchema.description.min(100)`. */
function serviceDescription(name: string): string {
  return (
    `Unsere ${name} wird von festen, geschulten Teams nach einem dokumentierten ` +
    `Ablauf durchgefuehrt. Wir arbeiten in vereinbarten Intervallen, halten die ` +
    `abgestimmten Zeiten ein und weisen jeden Einsatz nach.`
  );
}

async function seed(): Promise<void> {
  const started = Date.now();

  const workspace = await prisma.workspace.upsert({
    where: { slug: WORKSPACE.slug },
    create: { ...WORKSPACE },
    update: { name: WORKSPACE.name },
  });

  const project = await prisma.project.upsert({
    where: {
      workspaceId_slug: { workspaceId: workspace.id, slug: PROJECT.slug },
    },
    create: { ...PROJECT, workspaceId: workspace.id },
    update: { name: PROJECT.name, locale: PROJECT.locale, siteUrl: PROJECT.siteUrl },
  });

  const business = {
    name: "ScaleClean Gebaeudeservice",
    slug: "scaleclean",
    description:
      "ScaleClean Gebaeudeservice uebernimmt Gebaeudereinigung im gesamten " +
      "Ruhrgebiet und am Niederrhein, von der laufenden Unterhaltsreinigung bis " +
      "zur Bauschlussreinigung, mit festen Teams und dokumentierten Ablaeufen.",
    niche: "cleaning" as const,
    foundedYear: 2009,
    contactEmail: "kontakt@scaleclean.example",
    contactPhone: "+49 203 7654321",
    addressStreet: "Industriestrasse 40",
    addressCity: "Duisburg",
    addressState: "Nordrhein-Westfalen",
    addressPostalCode: "47051",
    addressCountry: "DE",
  };

  await prisma.business.upsert({
    where: { projectId: project.id },
    create: { id: "b0000000-0000-4000-8000-000000000001", ...business, projectId: project.id },
    update: business,
  });

  const content = {
    heroTitleTemplate: "{{service}} in {{city}} – {{business}}",
    heroSubtitleTemplate:
      "Professionelle {{service}} fuer Privat- und Geschaeftskunden in {{city}} " +
      "und Umgebung – zuverlaessig, gruendlich und fair.",
    ctaPrimary: "Kostenloses Angebot anfordern",
    ctaSecondary: "Jetzt anrufen",
    faqs: [
      { q: "Wie schnell ist ein Termin moeglich?", a: "In der Regel innerhalb weniger Tage." },
      { q: "Sind die Reinigungsmittel umweltfreundlich?", a: "Ja, ausschliesslich zertifizierte Mittel." },
      { q: "Erhalte ich ein Festpreisangebot?", a: "Ja, nach einer kurzen Bestandsaufnahme." },
      { q: "Ist das Personal versichert?", a: "Alle Mitarbeitenden sind fest angestellt und versichert." },
    ],
  };

  await prisma.contentTemplate.upsert({
    where: { projectId: project.id },
    create: { ...content, projectId: project.id },
    update: content,
  });

  // Services and locations are written in batches rather than one transaction:
  // a single 545-statement transaction is a needless lock, and a partial seed is
  // recoverable by re-running an idempotent script.
  for (const [index, name] of SERVICE_NAMES.slice(0, SERVICE_COUNT).entries()) {
    const slug = name.toLowerCase();
    const fields = {
      name,
      description: serviceDescription(name),
      benefits: ["Feste Teams", "Dokumentierte Ablaeufe", "Verbindliche Zeiten"],
      priceFrom: 25 + index,
      priceTo: 45 + index,
      priceCurrency: "EUR",
      templateId: null,
    };

    await prisma.service.upsert({
      where: { projectId_slug: { projectId: project.id, slug } },
      create: { id: `svc-scale-${index}`, slug, ...fields, projectId: project.id },
      update: fields,
    });
  }

  for (const [index, [city, postalCode]] of CITIES.slice(0, CITY_COUNT).entries()) {
    const slug = city.toLowerCase();
    const fields = {
      name: city,
      city,
      state: "Nordrhein-Westfalen",
      country: "DE",
      postalCode,
      latitude: null,
      longitude: null,
    };

    await prisma.location.upsert({
      where: { projectId_slug: { projectId: project.id, slug } },
      create: { id: `loc-scale-${index}`, slug, ...fields, projectId: project.id },
      update: fields,
    });
  }

  const pages = SERVICE_COUNT * CITY_COUNT;

  console.log(`✓ workspace  ${workspace.slug}`);
  console.log(`✓ project    ${project.slug} (${project.id})`);
  console.log(`✓ services   ${SERVICE_COUNT}`);
  console.log(`✓ locations  ${CITY_COUNT}`);
  console.log(`✓ seeded in  ${Date.now() - started}ms`);
  console.log(`\nThis project yields ${pages} pages. Generate them with:`);
  console.log(
    `  AI_MOCK=true USE_AI_GENERATION=true corepack pnpm --filter @staticforge/generator generate --project-id ${project.id}`,
  );
}

seed()
  .catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(`\n${error.name}: ${error.message}`);
    } else {
      console.error("\nUnknown error:", error);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
