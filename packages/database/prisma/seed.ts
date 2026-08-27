import { PrismaClient } from "@prisma/client";

/**
 * Seeds the sample tenant — the same German cleaning-service data the file
 * pipeline ships in `data/input/`.
 *
 * Run with `corepack pnpm --filter @staticforge/database exec prisma db seed`
 * once `DATABASE_URL` points at a real database.
 *
 * ## Idempotent
 *
 * Every write is an `upsert` keyed on a natural unique constraint — workspace
 * slug, `(workspaceId, slug)`, `(projectId, slug)`, and the 1:1 `projectId` on
 * business and content. Re-running restores the sample to this exact state
 * instead of failing on a unique-constraint violation, so it is safe to run
 * against a database that has already been seeded.
 *
 * ## Ids match the JSON fixtures on purpose
 *
 * Business, service and location ids are the literal values from
 * `data/input/*.json` rather than generated cuids. Generating from this project
 * therefore produces pages whose `businessId` / `serviceId` / `locationId` — and
 * so whose whole payload — match a local-file run exactly, which makes the two
 * modes directly comparable.
 */

const prisma = new PrismaClient({ log: ["error"] });

const WORKSPACE = {
  id: "ws-glanzfix",
  name: "GlanzFix",
  slug: "glanzfix",
} as const;

const PROJECT = {
  id: "prj-glanzfix-de",
  name: "GlanzFix Reinigungsservice",
  slug: "glanzfix-de",
  description: "Sample project seeded from data/input.",
  locale: "de",
  templateId: "default",
  // Without this a cloud run generates pages but publishes no sitemap, since
  // sitemap entries must be absolute URLs.
  siteUrl: "https://www.glanzfix.de",
} as const;

const BUSINESS = {
  // The UUID from data/input/businesses.json — BusinessSchema validates
  // `id` with `.uuid()`, so this may not be a cuid.
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  name: "GlanzFix Reinigungsservice",
  slug: "glanzfix-reinigungsservice",
  niche: "cleaning",
  description:
    "GlanzFix Reinigungsservice steht für gründliche und zuverlässige Gebäudereinigung im gesamten Ruhrgebiet. Vom Büro über die Grundreinigung bis zum Treppenhaus sorgen unsere geschulten Teams für makellose Sauberkeit – pünktlich, diskret und mit umweltfreundlichen Reinigungsmitteln.",
  foundedYear: 2014,
  contactEmail: "kontakt@glanzfix.de",
  contactPhone: "+49 203 1234567",
  addressStreet: "Königstraße 12",
  addressCity: "Duisburg",
  addressState: "Nordrhein-Westfalen",
  addressPostalCode: "47051",
  addressCountry: "DE",
} as const;

const CONTENT = {
  heroTitleTemplate: "{{service}} in {{city}} – {{business}}",
  heroSubtitleTemplate:
    "Professionelle {{service}} für Privat- und Geschäftskunden in {{city}} und Umgebung – zuverlässig, gründlich und fair.",
  ctaPrimary: "Kostenloses Angebot anfordern",
  ctaSecondary: "Jetzt anrufen",
  faqs: [
    {
      q: "Wie schnell ist ein Termin möglich?",
      a: "In der Regel können wir innerhalb weniger Tage einen passenden Termin in Ihrer Stadt anbieten.",
    },
    {
      q: "Sind die verwendeten Reinigungsmittel umweltfreundlich?",
      a: "Ja, wir setzen ausschließlich auf umweltschonende und zertifizierte Reinigungsmittel.",
    },
    {
      q: "Erhalte ich ein verbindliches Festpreisangebot?",
      a: "Nach einer kurzen Bestandsaufnahme erstellen wir Ihnen ein transparentes und verbindliches Angebot ohne versteckte Kosten.",
    },
    {
      q: "Ist Ihr Reinigungspersonal versichert?",
      a: "Alle Mitarbeiterinnen und Mitarbeiter sind fest angestellt, geschult und vollständig versichert.",
    },
  ],
} as const;

/** Shape of one seeded service. `slug` is curated, never derived. */
interface SeedService {
  id: string;
  name: string;
  slug: string;
  description: string;
  benefits: string[];
  priceFrom: number | null;
  priceTo: number | null;
  priceCurrency: string | null;
  templateId: string | null;
}

const SERVICES: SeedService[] = [
  {
    id: "svc-bueroreinigung",
    name: "Büroreinigung",
    // "bueroreinigung", not the "buroreinigung" that slug derivation would
    // produce — derivation strips diacritics rather than transliterating them.
    slug: "bueroreinigung",
    description:
      "Unsere professionelle Büroreinigung sorgt für ein hygienisches und gepflegtes Arbeitsumfeld. Wir reinigen Schreibtische, Böden, Sanitäranlagen und Gemeinschaftsräume zuverlässig nach Ihrem individuellen Zeitplan – auch außerhalb der Geschäftszeiten.",
    benefits: [
      "Flexible Reinigung außerhalb der Arbeitszeiten",
      "Geschultes und festes Reinigungspersonal",
      "Umweltfreundliche Reinigungsmittel",
    ],
    priceFrom: 25,
    priceTo: 45,
    priceCurrency: "EUR",
    templateId: null,
  },
  {
    id: "svc-grundreinigung",
    name: "Grundreinigung",
    slug: "grundreinigung",
    description:
      "Die Grundreinigung entfernt hartnäckigen Schmutz, der sich über die Zeit angesammelt hat. Wir behandeln Böden, Fugen und schwer zugängliche Bereiche intensiv und bringen Ihre Räume wieder in einen makellosen Zustand.",
    benefits: [
      "Tiefenreinigung auch schwer zugänglicher Bereiche",
      "Geeignet für Umzug, Renovierung und Saisonstart",
      "Sichtbar bessere Ergebnisse als bei der Unterhaltsreinigung",
    ],
    priceFrom: 35,
    priceTo: 60,
    priceCurrency: "EUR",
    templateId: null,
  },
  {
    id: "svc-treppenhausreinigung",
    name: "Treppenhausreinigung",
    slug: "treppenhausreinigung",
    description:
      "Mit unserer regelmäßigen Treppenhausreinigung bleibt der gemeinschaftliche Eingangsbereich Ihres Wohn- oder Geschäftshauses stets sauber. Wir wischen Stufen, Geländer und Briefkastenanlagen nach einem festen, verlässlichen Turnus.",
    benefits: [
      "Feste wöchentliche oder monatliche Intervalle",
      "Pflege von Treppen, Geländern und Eingangsbereich",
      "Ideal für Hausverwaltungen und Eigentümergemeinschaften",
    ],
    priceFrom: null,
    priceTo: null,
    priceCurrency: null,
    templateId: null,
  },
];

/** Shape of one seeded location. */
interface SeedLocation {
  id: string;
  name: string;
  slug: string;
  city: string;
  state: string;
  country: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

const LOCATIONS: SeedLocation[] = [
  {
    id: "loc-duisburg",
    name: "Duisburg",
    slug: "duisburg",
    city: "Duisburg",
    state: "Nordrhein-Westfalen",
    country: "DE",
    postalCode: "47051",
    latitude: 51.4344,
    longitude: 6.7623,
  },
  {
    id: "loc-essen",
    name: "Essen",
    slug: "essen",
    city: "Essen",
    state: "Nordrhein-Westfalen",
    country: "DE",
    postalCode: "45127",
    latitude: 51.4556,
    longitude: 7.0116,
  },
  {
    id: "loc-duesseldorf",
    name: "Düsseldorf",
    // Curated: derivation would give "dusseldorf".
    slug: "duesseldorf",
    city: "Düsseldorf",
    state: "Nordrhein-Westfalen",
    country: "DE",
    postalCode: "40213",
    latitude: 51.2277,
    longitude: 6.7735,
  },
];

async function seed(): Promise<void> {
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
    update: {
      name: PROJECT.name,
      description: PROJECT.description,
      locale: PROJECT.locale,
      templateId: PROJECT.templateId,
      siteUrl: PROJECT.siteUrl,
    },
  });

  // Business and ContentTemplate are 1:1 with the project, so `projectId` is
  // itself the unique key.
  const { id: businessId, ...businessFields } = BUSINESS;

  await prisma.business.upsert({
    where: { projectId: project.id },
    create: { id: businessId, ...businessFields, projectId: project.id },
    update: { ...businessFields },
  });

  await prisma.contentTemplate.upsert({
    where: { projectId: project.id },
    create: {
      ...CONTENT,
      faqs: [...CONTENT.faqs],
      projectId: project.id,
    },
    update: { ...CONTENT, faqs: [...CONTENT.faqs] },
  });

  for (const service of SERVICES) {
    const { id, slug, ...fields } = service;
    await prisma.service.upsert({
      where: { projectId_slug: { projectId: project.id, slug } },
      create: { id, slug, ...fields, projectId: project.id },
      // `id` is left out: changing a primary key on an existing row would drag
      // every generated page's foreign key with it.
      update: { ...fields },
    });
  }

  for (const location of LOCATIONS) {
    const { id, slug, ...fields } = location;
    await prisma.location.upsert({
      where: { projectId_slug: { projectId: project.id, slug } },
      create: { id, slug, ...fields, projectId: project.id },
      update: { ...fields },
    });
  }

  console.log(`✓ workspace  ${workspace.slug} (${workspace.id})`);
  console.log(`✓ project    ${project.slug} (${project.id})`);
  console.log(`✓ business   ${BUSINESS.slug}`);
  console.log(`✓ content    ${CONTENT.faqs.length} faqs`);
  console.log(`✓ services   ${SERVICES.length}`);
  console.log(`✓ locations  ${LOCATIONS.length}`);
  console.log(
    `\nThis project yields ${SERVICES.length * LOCATIONS.length} pages. Generate them with:`,
  );
  // No `--` separator: pnpm forwards it to the script as a literal argument,
  // where parseArgs rejects it as an unexpected positional.
  console.log(
    `  corepack pnpm --filter @staticforge/generator generate --project-id ${project.id}`,
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
