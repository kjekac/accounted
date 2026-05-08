/**
 * Handelsbanken CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator
 * Columns: Reskontradatum, Transaktionsdatum, Text, Belopp, Saldo
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 *
 * Notes:
 * - Filter rows with "Prel" prefix (preliminary/pending transactions)
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

export const handelsbankenFormat: BankFileFormat = {
  id: 'handelsbanken',
  name: 'Handelsbanken',
  description: 'Handelsbanken CSV (semicolon-delimited)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0]?.toLowerCase() || ''
    return (
      firstLine.includes(';') &&
      (firstLine.includes('reskontradatum') || firstLine.includes('transaktionsdatum'))
    )
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Parse header
    const headerLine = lines[0] || ''
    const headers = headerLine.split(';').map((h) => h.trim().toLowerCase().replace(/"/g, ''))

    const dateIdx = headers.findIndex(
      (h) => h.includes('reskontradatum') || h.includes('transaktionsdatum')
    )
    const txDateIdx = headers.findIndex((h) => h.includes('transaktionsdatum'))
    const descIdx = headers.findIndex((h) => h === 'text' || h.includes('beskrivning'))
    const amountIdx = headers.findIndex((h) => h.includes('belopp'))
    const balanceIdx = headers.findIndex((h) => h.includes('saldo'))

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: 1,
        message: 'Could not identify required columns',
        severity: 'error',
      })
      return {
        format: 'handelsbanken',
        format_name: 'Handelsbanken',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    // Prefer transaktionsdatum over reskontradatum if available
    const primaryDateIdx = txDateIdx >= 0 ? txDateIdx : dateIdx

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = line.split(';').map((f) => f.trim().replace(/^"|"$/g, ''))

      const date = fields[primaryDateIdx]
      const description = descIdx >= 0 ? fields[descIdx] : 'Unknown'
      const amountStr = fields[amountIdx]
      const balanceStr = balanceIdx >= 0 ? fields[balanceIdx] : undefined

      // Skip preliminary transactions
      if (description?.toLowerCase().startsWith('prel')) {
        skippedRows++
        continue
      }

      if (!date || !amountStr) {
        const missing = []
        if (!date) missing.push('datum')
        if (!amountStr) missing.push('belopp')
        issues.push({ row: i + 1, message: `Saknar ${missing.join(' och ')}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const amount = parseCommaDecimal(amountStr)
      if (isNaN(amount)) {
        issues.push({ row: i + 1, message: `Invalid amount: ${amountStr}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const normalizedDate = normalizeDate(date)
      if (!normalizedDate) {
        issues.push({ row: i + 1, message: `Invalid date: ${date}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const balance = balanceStr ? parseCommaDecimal(balanceStr) : null

      transactions.push({
        date: normalizedDate,
        description: (description || 'Unknown').trim(),
        amount,
        currency: 'SEK',
        balance: isNaN(balance as number) ? null : balance,
        reference: null,
        counterparty: null,
        raw_line: line,
      })
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'handelsbanken',
      format_name: 'Handelsbanken',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: lines.length - 1,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}
