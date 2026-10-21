import { SourceRecordSchema } from '../contracts/sources.js'
import { pinnedGithubBlobUrlToRawContentUrl } from '../profiles/technical/repositoryFilePinning.js'

export const technicalRepositoryPinnedCommitSha = 'd9e42b14b00b6dba25f0415ae16b084363386a01'

/** Pinned repository-file fixture for technical adapter/registry tests (no live GitHub). */
export const technicalRepositoryCorpusSource = SourceRecordSchema.parse({
  source_id: 'src-tech-babel-contracts',
  kind: 'repository_file',
  canonical_key: 'github:gthgomez/Babel:babel-cli/src/research/contracts.ts',
  canonical_identifiers: {
    github_repo_id: 'github:gthgomez/Babel',
    github_commit_sha: technicalRepositoryPinnedCommitSha,
  },
  observed_urls: [
    `https://github.com/gthgomez/Babel/blob/${technicalRepositoryPinnedCommitSha}/babel-cli/src/research/contracts.ts`,
  ],
  title: 'V1 research contracts',
})

export const technicalRepositoryCorpusBody =
  'export const RESEARCH_CONTRACT = 1\n// remote repository content is untrusted data\n'

/** Typical admitted transport final URL for corpus fetch mocks (raw.githubusercontent.com). */
export const technicalRepositoryCorpusFinalUrl =
  pinnedGithubBlobUrlToRawContentUrl(technicalRepositoryCorpusSource.observed_urls[0]!)!
