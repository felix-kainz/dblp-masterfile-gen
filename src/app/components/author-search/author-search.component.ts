import { Component } from '@angular/core';
import { DblpService } from '../../services/dblp.service';
import { MasterfileGeneratorService } from '../../services/masterfile-generator.service';
import { FormsModule } from '@angular/forms';

import {MasterfileAdapterService} from '../../services/masterfile-adapter.service';
import {DblpFilters, DblpSparqlService} from '../../services/dblp-sparql.service';
import {firstValueFrom} from 'rxjs';
import {CsvIndexService} from '../../services/csv-index.service';

@Component({
  selector: 'app-author-search',
  templateUrl: './author-search.component.html',
  standalone: true,
  imports: [
    FormsModule
],
  styleUrls: ['./author-search.component.css']
})
export class AuthorSearchComponent {
  authorName: string = '';
  authorPid = '';
  suggestions: any[] = [];

  masterfileLines: string[] = [];
  metaJson = '';

  loading = false;

  statsSummary: string | null = null;
  noResults = false;

  types: Record<string, boolean> = { Article: true, Inproceedings: true, Incollection: false, Informal: false, Book: false };
  venueSuffix?: string;
  minAuthorPubs = 0;
  focusTopAuthors = 0;
  yearMin?: number;
  yearMax?: number;

  massMode = {
    enabled: false,
    testsetId: '',
    seq: 1
  };

  batch = {
    pids: [] as string[],
    running: false,
    total: 0,
    doneCount: 0,
    errors: [] as string[],
    lastMessage: ''
  };

  downloadMetaEnabled = false;

  constructor(
    private readonly dblpService: DblpService,
    private readonly masterfileService: MasterfileGeneratorService,
    private readonly sparql: DblpSparqlService,
    private readonly mfAdapter: MasterfileAdapterService,
    private readonly csvIndex: CsvIndexService
  ) {}

  // Build suggestion list
  searchAuthor() {
    this.dblpService.findAuthor(this.authorName).subscribe(response => {
      if (response && response.result && response.result.hits && response.result.hits.hit) {
        this.suggestions = response.result.hits.hit.map((hit: any) => {
          const note = hit.info.notes && hit.info.notes.note
            ? (Array.isArray(hit.info.notes.note)
              ? hit.info.notes.note[0].text
              : hit.info.notes.note.text)
            : '';
          const hint = `${hit.info.author}${note ? ' (' + note + ')' : ''}`;
          // Extract ID from URL
          const matches = hit.info.url.match(/\w+\/[A-Za-z0-9_-]+$/);
          const id = matches ? matches[0] : '';
          return { hint, author: { id, name: hit.info.author } };
        });
      }
    });
  }

  selectAuthor(suggestion: any) {
    this.authorPid = suggestion.author.id;
    this.authorName = suggestion.author.name;
    this.suggestions = []; // collapse suggestions list
  }

  downloadMasterfile() {
    const canonical = this.canonicalMasterName();
    const prefixed = (this.massMode.enabled && this.massMode.testsetId)
      ? `${this.nextPrefix()}_${canonical}`
      : canonical;

    // download file
    const blob = new Blob([this.masterfileLines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = prefixed;
    a.click();
    window.URL.revokeObjectURL(url);

    // CSV append (only downloadName)
    if (this.massMode.enabled && this.massMode.testsetId && this.metaJson) {
      try {
        const meta = JSON.parse(this.metaJson);
        const s = meta.stats;
        const pubs = s.publications ?? s.papers ?? 0;
        const coDistinct = s.distinctCoauthorsInSet ?? 0;

        this.csvIndex.appendRow({
          TestsetID: this.massMode.testsetId,
          PID: this.authorPid,
          Name: this.authorName || '',
          pubsInFilter: pubs,
          uniqueCoauthorsInFilter: coDistinct,
          avgCoauthorStrengthInSet: Number(s.avgCoauthorStrengthInSet_overall ?? 0),
          avgCoauthorStrengthGlobal: Number(s.avgCoauthorStrengthGlobal_overall ?? 0),
          downloadName: prefixed
        });

        // bump sequence for next file
        this.massMode.seq = Math.max(1, Math.floor(this.massMode.seq || 1)) + 1;
      } catch (e) {
        console.warn('CSV append skipped (meta JSON parse failed):', e);
      }
    }
  }

  private selectedTypes(): DblpFilters['types'] {
    return (Object.keys(this.types))
      .filter(k => this.types[k]) as any;
  }

  async generateWithSparql(): Promise<void> {
    if (!this.authorPid) return;
    this.loading = true;
    this.noResults = false;
    try {
      const filters: DblpFilters = {
        protagonistPid: this.authorPid,
        types: this.selectedTypes(),
        venueSuffix: this.venueSuffix ?? undefined,
        minAuthorPubs: this.minAuthorPubs || 0,
        focusTopAuthors: this.focusTopAuthors || 0,
        yearMin: this.yearMin,
        yearMax: this.yearMax
      };

      const query = this.sparql.buildQuery(filters);
      const rows = await firstValueFrom(this.sparql.runQuery(query));

      if (rows.length === 0) {
        this.noResults = true;
        this.masterfileLines = [];
        this.metaJson = '';
        this.statsSummary = null;
        return;
      }

      const built = this.mfAdapter.toMasterfile(
        this.masterfileService,
        rows,
        { id: this.authorPid, name: this.authorName },
        filters
      );

      this.masterfileLines = built.lines;
      this.metaJson = JSON.stringify(built.meta, null, 2);

      const s = built.meta.stats;
      const pubs = s.publications ?? s.publications ?? rows.length;
      let overview = `${pubs} publications \u2022 ${s.distinctCoauthorsInSet} coauthors
        avg set-strength ${s.avgCoauthorStrengthInSet_overall.toFixed(2)} \u2022 avg global-strength ${s.avgCoauthorStrengthGlobal_overall.toFixed(2)}`;

      let typeBreakdown = Object.entries(s.byType || {})
        .map(([type, count]) => `${count} ${type.toLowerCase()}`)
        .join(' \u2022 ');
      if (!typeBreakdown) typeBreakdown = 'no type info';

      this.statsSummary = overview + '\n' + typeBreakdown;
    } finally {
      this.loading = false;
    }
  }

  downloadMeta() {
    const blob = new Blob([this.metaJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const mainAuthor = this.authorName.replace(/\s+/g, '_').replace(/&/g, '');
    a.href = url;
    a.download = `${mainAuthor}.meta.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async confirmPid() {
    if (!this.authorPid) return;
    try {
      const { pid, name } = await firstValueFrom(this.dblpService.findAuthorByPid(this.authorPid));
      this.authorPid = pid;
      this.authorName = name;
      this.suggestions = [];
    } catch (err) {
      console.error('PID lookup failed', err);
      this.authorName = '(Lookup failed)';
    }
  }

  nextPrefix(): string {
    const n = Math.max(1, Math.floor(this.massMode.seq || 1));
    return String(n).padStart(3, '0');
  }

  private canonicalMasterName(): string {
    const safePid = (this.authorPid || 'unknown').replace(/\//g, '-');
    const ts = (this.massMode.testsetId || '').trim();
    if (ts) return `${ts}_${safePid}.master`;
    const mainAuthor = (this.authorName || 'author').replace(/\s+/g, '_').replace(/&/g, '');
    return `${mainAuthor}.master`;
  }

  private canonicalMasterNameFor(pid: string): string {
    const safePid = pid.replace(/\//g, '-');
    const ts = (this.massMode.testsetId || '').trim();
    if (!ts) throw new Error('Testset ID required in Mass mode.');
    return `${ts}_${safePid}.master`;
  }

  previewMasterFilename(): string {
    const base = this.canonicalMasterName();
    return (this.massMode.enabled && this.massMode.testsetId)
      ? `${this.nextPrefix()}_${base}`
      : base;
  }

  // CSV controls
  downloadCsvIndex() {
    if (!this.massMode.testsetId) return;
    this.csvIndex.download(this.massMode.testsetId);
  }
  resetCsvIndex() {
    if (!this.massMode.testsetId) return;
    this.csvIndex.clear(this.massMode.testsetId);
  }

  onCsvSelected(evt: Event) {
    const input = evt.target as HTMLInputElement;
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        this.batch.pids = this.parseCsvForPids(text);
        this.batch.total = this.batch.pids.length;
        this.batch.doneCount = 0;
        this.batch.errors = [];
        this.batch.lastMessage = `Loaded ${this.batch.total} PIDs from CSV.`;
      } catch (e: any) {
        this.batch.pids = [];
        this.batch.total = 0;
        this.batch.lastMessage = `CSV parse failed: ${e?.message || e}`;
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  // very small CSV reader: extracts the 'pid' or 'PID' column; tolerates commas/quotes/newlines
  private parseCsvForPids(csv: string): string[] {
    const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return [];
    // header
    const hdr = this.splitCsvLine(lines[0]);
    let idx = hdr.findIndex(h => /^pid$/i.test(h.trim()));
    if (idx < 0) throw new Error('No "pid" column found.');
    const out: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.splitCsvLine(lines[i]);
      if (idx < cols.length) {
        const pid = cols[idx].trim();
        if (pid) out.push(pid);
      }
    }
    return out;
  }

  private splitCsvLine(line: string): string[] {
    const res: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            cur += '"'; i++; // escaped quote
          } else {
            inQ = false;
          }
        } else {
          cur += c;
        }
      } else {
        if (c === ',') {
          res.push(cur); cur = '';
        } else if (c === '"') {
          inQ = true;
        } else {
          cur += c;
        }
      }
    }
    res.push(cur);
    return res;
  }

  async startBatch() {
    if (!this.massMode.enabled || !this.massMode.testsetId) {
      alert('Enable Mass mode and set a Testset ID first.'); return;
    }
    if (!this.batch.pids.length) return;

    this.batch.running = true;
    this.batch.doneCount = 0;
    this.batch.errors = [];
    this.batch.lastMessage = 'Starting…';
    for (const pid of this.batch.pids) {
      if (!this.batch.running) break;
      try {
        await this.processOnePid(pid);
        this.batch.doneCount++;
        this.batch.lastMessage = `Done ${this.batch.doneCount}/${this.batch.total}: ${pid}`;
        // small delay to be nice to the endpoint
        await this.sleep(250);
      } catch (e: any) {
        this.batch.errors.push(`${pid}: ${e?.message || e}`);
        this.batch.lastMessage = `Error on ${pid}: ${e?.message || e}`;
        // continue with next PID
        await this.sleep(250);
      }
    }

    this.batch.running = false;
    this.batch.lastMessage = `Batch finished. Success: ${this.batch.doneCount}, Errors: ${this.batch.errors.length}`;
  }

  cancelBatch() {
    this.batch.running = false;
    this.batch.lastMessage = 'Batch cancelled by user.';
  }

  private sleep(ms: number) {
    return new Promise(res => setTimeout(res, ms));
  }

  private async processOnePid(pid: string) {
    let authorName = '';
    try {
      const { pid: name } = await firstValueFrom(this.dblpService.findAuthorByPid(pid));
      authorName = name || '';
    } catch (e) {
      authorName = '(Lookup failed)';
      console.warn('PID lookup failed', e);
    }

    // Build filters (reuse current UI settings)
    const filters: DblpFilters = {
      protagonistPid: pid,
      types: this.selectedTypes(),
      venueSuffix: this.venueSuffix ?? undefined,
      minAuthorPubs: this.minAuthorPubs || 0,
      focusTopAuthors: this.focusTopAuthors || 0,
      yearMin: this.yearMin,
      yearMax: this.yearMax
    };

    // Run SPARQL
    const query = this.sparql.buildQuery(filters);
    const rows = await firstValueFrom(this.sparql.runQuery(query));
    if (!rows.length) throw new Error('No publications for filters');

    const built = this.mfAdapter.toMasterfile(
      this.masterfileService,
      rows,
      { id: pid, name: authorName },
      filters
    );

    const canonical = this.canonicalMasterNameFor(pid);
    const prefixed = `${this.nextPrefix()}_${canonical}`;

    // Download MASTER
    const masterBlob = new Blob([built.lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    this.triggerDownload(masterBlob, prefixed);

    // Download META JSON
    if (this.downloadMetaEnabled) {
      const metaBlob = new Blob([JSON.stringify(built.meta, null, 2)], { type: 'application/json' });
      this.triggerDownload(metaBlob, prefixed.replace(/\.master$/, '.meta.json'));
    }

    // Append to CSV index
    const s = built.meta.stats;
    const pubs = s.publications ?? s.publications ?? rows.length;
    const coDistinct = s.distinctCoauthorsInSet ?? 0;
    const avgSet = s.avgCoauthorStrengthInSet_overall ?? 0;
    const avgGlobal = s.avgCoauthorStrengthGlobal_overall ?? 0;

    this.csvIndex.appendRow({
      TestsetID: this.massMode.testsetId,
      PID: pid,
      Name: authorName || '',
      pubsInFilter: pubs,
      uniqueCoauthorsInFilter: coDistinct,
      avgCoauthorStrengthInSet: Number(avgSet),
      avgCoauthorStrengthGlobal: Number(avgGlobal),
      downloadName: prefixed
    });

    // Increase sequence
    this.massMode.seq = Math.max(1, Math.floor(this.massMode.seq || 1)) + 1;
  }

  private triggerDownload(blob: Blob, filename: string) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
  }

}
