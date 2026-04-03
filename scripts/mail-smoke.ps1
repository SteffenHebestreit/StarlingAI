$ErrorActionPreference = 'Stop'

function Invoke-MailService {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Body
    )

    $nodeScript = @'
const [method, url, bodyBase64] = process.argv.slice(1);
const init = {
  method,
  headers: {
    Accept: 'application/json',
  },
};

if (bodyBase64 && bodyBase64 !== '__NONE__') {
  init.headers['Content-Type'] = 'application/json';
    init.body = Buffer.from(bodyBase64, 'base64').toString('utf8');
}

const response = await fetch(url, init);
const text = await response.text();
process.stdout.write(JSON.stringify({ status: response.status, body: text }));
'@

    $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Compress -Depth 20 } else { $null }
    $bodyBase64 = if ($null -ne $json) {
        [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    } else {
        '__NONE__'
    }
    $args = @(
        'exec',
        'starlingai-mail-service-1',
        'node',
        '--input-type=module',
        '-e', $nodeScript,
        $Method,
        "http://localhost:5020$Path",
        $bodyBase64
    )

    $raw = & docker @args
    if ($LASTEXITCODE -ne 0) {
        throw "docker exec curl failed for $Method $Path"
    }

    $wireResponse = $raw | ConvertFrom-Json
    $status = [int]$wireResponse.status
    $bodyText = [string]$wireResponse.body
    $bodyObject = $null
    if ($bodyText) {
        $bodyObject = $bodyText | ConvertFrom-Json
    }

    [pscustomobject]@{
        Status = $status
        Body = $bodyObject
        RawBody = $bodyText
    }
}

function Assert-Ok {
    param(
        [Parameter(Mandatory = $true)]$Response,
        [Parameter(Mandatory = $true)][string]$Step
    )

    if ($Response.Status -lt 200 -or $Response.Status -ge 300) {
        throw "$Step failed with HTTP $($Response.Status): $($Response.RawBody)"
    }
}

function Find-MessageBySubject {
    param(
        [Parameter(Mandatory = $true)][string]$AccountId,
        [Parameter(Mandatory = $true)][string]$Subject,
        [Parameter(Mandatory = $true)][string[]]$Mailboxes,
        [int]$MaxAttempts = 24,
        [int]$DelaySeconds = 5
    )

    $query = "subject:`"$Subject`""
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $response = Invoke-MailService -Method 'POST' -Path '/api/messages/search' -Body @{
            accountIds = @($AccountId)
            mailboxes = $Mailboxes
            query = $query
            limit = 10
        }
        Assert-Ok -Response $response -Step "search attempt $attempt"
        $messages = @($response.Body)
        if ($messages.Count -gt 0) {
            return $messages[0]
        }
        Start-Sleep -Seconds $DelaySeconds
    }

    throw "Timed out waiting for message with subject '$Subject' in $($Mailboxes -join ', ')"
}

$accountsResponse = Invoke-MailService -Method 'GET' -Path '/api/accounts'
Assert-Ok -Response $accountsResponse -Step 'list accounts'
$accounts = @($accountsResponse.Body)
if ($accounts.Count -eq 0) {
    throw 'No mail accounts configured in mail-service.'
}

$account = $accounts | Where-Object { $_.id -eq 'work' } | Select-Object -First 1
if (-not $account) {
    $account = $accounts[0]
}

$token = Get-Date -Format 'yyyyMMdd-HHmmss'
$subject = "StarlingAI smoke $token"
$folder = "StarlingAI-Smoke-$token"

$draftResponse = Invoke-MailService -Method 'POST' -Path '/api/drafts' -Body @{
    accountId = $account.id
    to = @($account.address)
    subject = $subject
    textBody = "Live smoke test created at $(Get-Date -Format o)."
}
Assert-Ok -Response $draftResponse -Step 'create draft'
$draftId = $draftResponse.Body.id

$sendResponse = Invoke-MailService -Method 'POST' -Path "/api/drafts/$draftId/send"
Assert-Ok -Response $sendResponse -Step 'send draft'

$message = Find-MessageBySubject -AccountId $account.id -Subject $subject -Mailboxes @('INBOX')

$createMailboxResponse = Invoke-MailService -Method 'POST' -Path '/api/mailboxes' -Body @{
    accountId = $account.id
    path = $folder
}
Assert-Ok -Response $createMailboxResponse -Step 'create mailbox'

$moveResponse = Invoke-MailService -Method 'POST' -Path '/api/messages/move' -Body @{
    items = @(@{
        accountId = $account.id
        mailbox = $message.mailbox
        uid = [int]$message.uid
    })
    destinationMailbox = $folder
    createDestination = $false
}
Assert-Ok -Response $moveResponse -Step 'move message'

$movedMessage = Find-MessageBySubject -AccountId $account.id -Subject $subject -Mailboxes @($folder) -MaxAttempts 12 -DelaySeconds 2

$deleteMessageResponse = Invoke-MailService -Method 'POST' -Path '/api/messages/delete' -Body @{
    items = @(@{
        accountId = $account.id
        mailbox = $movedMessage.mailbox
        uid = [int]$movedMessage.uid
    })
    permanent = $false
}
Assert-Ok -Response $deleteMessageResponse -Step 'delete message'

Start-Sleep -Seconds 2

$deleteMailboxResponse = Invoke-MailService -Method 'DELETE' -Path '/api/mailboxes' -Body @{
    accountId = $account.id
    path = $folder
}
Assert-Ok -Response $deleteMailboxResponse -Step 'delete mailbox'

$mailboxesResponse = Invoke-MailService -Method 'GET' -Path "/api/accounts/$($account.id)/mailboxes"
Assert-Ok -Response $mailboxesResponse -Step 'list mailboxes after cleanup'
$remainingFolder = @($mailboxesResponse.Body) | Where-Object { $_.path -eq $folder } | Select-Object -First 1

@(
    "accountId=$($account.id)",
    "subject=$subject",
    "createdDraftId=$draftId",
    "inboxMailbox=$($message.mailbox)",
    "inboxUid=$([int]$message.uid)",
    "movedMailbox=$($movedMessage.mailbox)",
    "movedUid=$([int]$movedMessage.uid)",
    "deletePermanent=$($deleteMessageResponse.Body.permanent)",
    "deleteCount=$($deleteMessageResponse.Body.count)",
    "deletedMailboxPath=$($deleteMailboxResponse.Body.path)",
    "folderStillPresent=$([bool]$remainingFolder)"
) -join "`n"