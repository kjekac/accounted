import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { getBranding } from '@/lib/branding/service'

export function generateMetadata(): Metadata {
  return {
    title: `Personuppgiftsbitradesavtal - ${getBranding().appName}`,
  }
}

export default function DPAPage() {
  const { appName, legalEntity, privacyEmail } = getBranding()
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Personuppgiftsbitradesavtal (DPA)
          </h1>
          <p className="text-muted-foreground">
            Enligt GDPR Art. 28 | Senast uppdaterad: 2026-03-05
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. Roller</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Detta personuppgiftsbitradesavtal (&quot;DPA&quot;) ingår mellan:
            </p>
            <ul>
              <li><strong>Personuppgiftsansvarig (&quot;den Ansvarige&quot;):</strong> Du som användare av {appName},
                i egenskap av ansvarig för de personuppgifter du registrerar i tjänsten
                (kunder, leverantörer, anställda m.fl.).</li>
              <li><strong>Personuppgiftsbiträde (&quot;Biträdet&quot;):</strong> {legalEntity}, som tillhandahåller
                {' '}{appName}-tjänsten och behandlar personuppgifter på dina vägnar.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Behandlingens syfte och omfattning</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>Biträdet behandlar personuppgifter för följande ändamål:</p>
            <ul>
              <li>Tillhandahållande av bokförings- och redovisningstjänster</li>
              <li>Lagring och arkivering av bokföringsmaterial</li>
              <li>Fakturering och betalningshantering</li>
              <li>Bankkontosynkronisering (PSD2)</li>
              <li>AI-assisterad kategorisering och kvittohantering (efter separat samtycke)</li>
            </ul>
            <p>Kategorier av registrerade vars uppgifter behandlas:</p>
            <ul>
              <li>Den Ansvariges kunder (namn, kontaktuppgifter, organisationsnummer)</li>
              <li>Den Ansvariges leverantörer (namn, kontaktuppgifter, bankuppgifter)</li>
              <li>Den Ansvarige själv (kontouppgifter, företagsinformation)</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Tekniska och organisatoriska åtgärder</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>Biträdet vidtar följande åtgärder för att skydda personuppgifterna:</p>
            <ul>
              <li><strong>Kryptering:</strong> All data krypteras i transit (TLS 1.3) och i vila (AES-256)</li>
              <li><strong>Åtkomstkontroll:</strong> Row Level Security (RLS) säkerställer att varje användare
                enbart kan komma åt sina egna uppgifter</li>
              <li><strong>Autentisering:</strong> Säkra inloggningsmetoder (magic link, inga lösenord lagrade)</li>
              <li><strong>Integritetskontroll:</strong> SHA-256 checksummor för alla dokument, med
                regelbunden verifiering</li>
              <li><strong>Revisionslogg:</strong> Alla ändringshandelser loggas automatiskt av databasen
                (ej redigerbara)</li>
              <li><strong>Oföränderlig bokföring:</strong> Bokförda verifikationer kan inte ändras eller
                raderas (databasutlösare)</li>
              <li><strong>Säkerhetskopior:</strong> Kontinuerliga databaskopior med point-in-time-recovery</li>
              <li><strong>EU-lagring:</strong> All primär datalagring sker i EU (eu-central-1)</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4. Underbiträden</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Biträdet använder underbiträden för att tillhandahålla tjänsten. En fullständig
              förteckning över underbiträden, inklusive syfte och geografisk plats, finns i
              vår{' '}
              <Link href="/privacy" className="text-primary underline underline-offset-4">
                integritetspolicy
              </Link>.
            </p>
            <p>
              Biträdet kommer att informera den Ansvarige minst 30 dagar i förväg innan
              en ny underbiträde anlitas, så att den Ansvarige har möjlighet att invända.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>5. Dataintrångsnotifiering</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vid en personuppgiftsincident ska Biträdet utan onödigt dröjsmål, och senast
              inom 72 timmar från det att incidenten upptäcktes, meddela den Ansvarige.
              Meddelandet ska innehålla:
            </p>
            <ul>
              <li>Typ av personuppgiftsincident</li>
              <li>Kategorier och ungefärligt antal registrerade som berörts</li>
              <li>Sannolika konsekvenser av incidenten</li>
              <li>Åtgärder som vidtagits eller föreslås för att hantera incidenten</li>
            </ul>
            <p>
              Biträdet ska bistå den Ansvarige med den information som behövs för att den
              Ansvarige ska kunna uppfylla sin anmälningsplikt till IMY (Integritetsskyddsmyndigheten).
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>6. Revisionsrätt</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Den Ansvarige har rätt att, direkt eller genom en oberoende revisor, utföra
              revisioner och inspektioner för att säkerställa att Biträdet uppfyller sina
              åtaganden enligt detta avtal. Biträdet ska tillhandahålla all nödvändig
              information och medverka till revisioner.
            </p>
            <p>
              Revisioner ska ske med rimligt varsel (minst 30 dagar) och under ordinarie
              kontorstider. Biträdet kan erbjuda alternativ i form av tredjepartsgranskningar
              eller certifieringar.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>7. Radering vid avslut</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vid uppsägning av tjänsten ska Biträdet, enligt den Ansvariges val:
            </p>
            <ul>
              <li>
                <strong>Återlämna:</strong> Exportera alla personuppgifter i maskinläsbart format
                (SIE4, JSON, CSV) via tjänstens exportfunktioner.
              </li>
              <li>
                <strong>Radera:</strong> Radera alla personuppgifter inom 30 dagar från
                användarens begäran, med undantag för uppgifter som måste bevaras enligt lag.
              </li>
            </ul>
            <p>
              <strong>Undantag:</strong> Bokföringsmaterial som omfattas av Bokföringslagen (BFL)
              7 kap. 2 § (7 års arkiveringskrav) raderas först när lagringsfristen löpt ut.
              Under denna period är materialet skyddat mot obehörig åtkomst och ändring.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              Detta personuppgiftsbitradesavtal träder i kraft när du skapar ett konto på
              {' '}{appName} och gäller så länge du använder tjänsten. För frågor, kontakta oss
              på {privacyEmail}.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
