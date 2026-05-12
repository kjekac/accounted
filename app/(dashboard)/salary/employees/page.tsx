'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, ArrowLeft, UserCircle } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency } from '@/lib/utils'
import type { Employee } from '@/types'

const EMPLOYMENT_LABELS: Record<string, string> = {
  employee: 'Anställd',
  company_owner: 'Företagsledare',
  board_member: 'Styrelseledamot',
}

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const { canWrite } = useCanWrite()

  useEffect(() => {
    async function load() {
      const res = await fetch('/api/salary/employees')
      if (res.ok) {
        const { data } = await res.json()
        setEmployees(data || [])
      }
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/salary" aria-label="Tillbaka till löner"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Anställda</h1>
            <p className="text-sm text-muted-foreground mt-1">{employees.length} registrerade</p>
          </div>
        </div>
        {canWrite && (
          <Button asChild>
            <Link href="/salary/employees/new">
              <Plus className="mr-2 h-4 w-4" />
              Ny anställd
            </Link>
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : employees.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={UserCircle}
              title="Inga anställda"
              description="Lägg till anställda för att kunna skapa lönekörningar och AGI-deklarationer."
              actionLabel={canWrite ? 'Lägg till anställd' : undefined}
              actionHref={canWrite ? '/salary/employees/new' : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Namn</TableHead>
                  <TableHead>Personnummer</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead className="text-right">Lön</TableHead>
                  <TableHead className="text-right">Sysselsättningsgrad</TableHead>
                  <TableHead>Skattetabell</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map(emp => (
                  <TableRow key={emp.id}>
                    <TableCell>
                      <Link href={`/salary/employees/${emp.id}`} className="font-medium hover:underline">
                        {emp.first_name} {emp.last_name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {emp.personnummer}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {EMPLOYMENT_LABELS[emp.employment_type] || emp.employment_type}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {emp.salary_type === 'hourly'
                        ? emp.hourly_rate ? `${formatCurrency(emp.hourly_rate)}/tim` : '—'
                        : emp.monthly_salary ? formatCurrency(emp.monthly_salary) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {emp.employment_degree}%
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {emp.tax_table_number ? `Tabell ${emp.tax_table_number}, kol ${emp.tax_column}` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
