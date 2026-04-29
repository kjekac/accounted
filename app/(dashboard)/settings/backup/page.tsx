import { BackupDownloadForm } from '@/components/settings/BackupDownloadForm'
import { getBranding } from '@/lib/branding/service'

export default function BackupSettingsPage() {
  const { appName } = getBranding()
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Säkerhetsbackup
        </h2>
        <p className="text-sm text-muted-foreground max-w-prose">
          Ladda ner en egen kopia av all räkenskapsinformation — SIE-filer, kvitton,
          underlag och behandlingshistorik — i en enda ZIP-fil. Säkerhetsbackupen är din
          egen kopia för trygghet och portabilitet. {appName.toLowerCase()} arkiverar all
          räkenskapsinformation i minst 7 år enligt BFL 7 kap. 2 §, så din backup ersätter
          inte vårt lagkrav — den kompletterar det.
        </p>
      </section>

      <BackupDownloadForm />
    </div>
  )
}
