import { App, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { AwsIntegration, Integration, IntegrationOptions, IRestApi, JsonSchema, JsonSchemaType, JsonSchemaVersion, LogGroupLogDestination, MethodLoggingLevel, MethodOptions, Model, RequestValidator, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { Effect, IRole, Policy, PolicyStatement, PrincipalBase, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Chain, Choice, Condition, IStateMachine, JsonPath, LogLevel, Pass, StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { CallAwsService } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const serviceApiGateway = new ServicePrincipal('apigateway.amazonaws.com');

    const logGroups = new LogGroup(this, 'TextLogGroups', {
      logGroupName: 'TextLogs',
      retention: RetentionDays.ONE_DAY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    logGroups.grantWrite(serviceApiGateway);

    const detectLanguage = new CallAwsService(this, 'DetectDominantLanguage', {
      service: 'comprehend',
      action: 'detectDominantLanguage',
      iamResources: ['*'],
      parameters: {
        Text: JsonPath.stringAt('$.txt'),
      },
      resultPath: '$.result',
      outputPath: '$',
    });

    const formatResult = new Pass(this, 'FormatResult', {
      parameters: {
        'Text.$': '$.txt',
        'Language.$': '$.result.Languages[0].LanguageCode',
      },
    });

    const translateNonPTLanguage = new Choice(this, 'TranslateNonPTLanguage');

    const detectSentiment = new CallAwsService(this, 'DetectSentiment', {
      service: 'comprehend',
      action: 'detectSentiment',
      iamResources: ['*'],
      parameters: {
        Text: JsonPath.stringAt('$.Text'),
        LanguageCode: JsonPath.stringAt('$.Language'),
      },
    });

    const translateText = new CallAwsService(this, 'TranslateText', {
      service: 'translate',
      action: 'translateText',
      iamResources: ['*'],
      parameters: {
        Text: JsonPath.stringAt('$.Text'),
        SourceLanguageCode: JsonPath.stringAt('$.Language'),
        TargetLanguageCode: 'pt',
      },
      resultPath: '$.result',
      outputPath: '$',
    });
    const formatTranslatedResult = new Pass(this, 'FormatTranslatedResult', {
      parameters: {
        'Text.$': '$.result.TranslatedText',
        'Language.$': '$.result.TargetLanguageCode'
      },
    });
    translateText.next(formatTranslatedResult).next(detectSentiment);    

    translateNonPTLanguage.when(Condition.stringEquals('$.Language', 'pt'), detectSentiment);
    translateNonPTLanguage.when(Condition.not(Condition.stringEquals('$.Language', 'pt')), translateText);

    const chain = Chain.start(detectLanguage)
      .next(formatResult)
      .next(translateNonPTLanguage);
    const stateMachine = new StateMachine(this, 'SentimentAnalisys', {
      stateMachineName: 'SentimentAnalisys',
      definition: chain,
      tracingEnabled: true,
      logs: {
        destination: logGroups,
        level: LogLevel.ALL,
      },
    });

    const gtwRole = this.gatewayStepFunctionsRole(serviceApiGateway, stateMachine.stateMachineArn);

    const rest = new RestApi(this, 'RestApi', {
      restApiName: 'gateway-sf-text-sentiment',
      deployOptions: {
        tracingEnabled: true,
        loggingLevel: MethodLoggingLevel.INFO,
        accessLogDestination: new LogGroupLogDestination(logGroups),
      },
    });

    const method:MethodOptions = {
      methodResponses: [{ statusCode: '200' }],
      requestModels: {
        'application/json': this.requestModels(rest, 'txt'),
      },
      requestValidator: new RequestValidator(this, 'PostValidator', {
        requestValidatorName: 'validator',
        restApi: rest,
        validateRequestBody: true,
        validateRequestParameters: false,
      }),
    };
    const resource = rest.root.addResource('sentiment');
    resource.addMethod('POST', this.postIntegration(gtwRole, stateMachine), method);
  }

  postIntegration(gtwRole:IRole, sf:IStateMachine):Integration {
    const integrationOpt:IntegrationOptions = {
      credentialsRole: gtwRole,
      integrationResponses: [
        {
          statusCode: '200',
          responseTemplates: {
            'application/json': `
              #if ($input.path('$.__type') != "")
                #set ($context.responseOverride.status = 500)
                {
                  "requestId": "$context.requestId",
                  "message": "$input.path('$.message').trim()"
                }
              #else
                #set ($context.responseOverride.status = 500)
                {
                  "requestId": "$context.requestId",
                  "executionArn": "$input.path('$.executionArn').trim()",
                  "startDate": "$input.path('$.startDate')"
                }
              #end
            `,
          },
        },
      ],
      requestTemplates: { // "name": "sf-$util.base64Encode($util.escapeJavaScript($input.body)).hashCode()",
        'application/json': `{
          "input": "$util.escapeJavaScript($input.body)",
          "stateMachineArn": "${sf.stateMachineArn}"
        }`,
      },
    };
    return new AwsIntegration({
      service: 'states',
      action: 'StartExecution',
      integrationHttpMethod: 'POST',
      options: integrationOpt,
    });
  }

  gatewayStepFunctionsRole(service:PrincipalBase, sfArn:string) {
    const gatewayStepFunctionsRole = new Role(this, 'GatewayStepFunctionsRole', {
      assumedBy: service,
    });
    gatewayStepFunctionsRole.attachInlinePolicy(
      new Policy(this, 'TextSentimentPolicy', {
        statements: [
          new PolicyStatement({
            actions: ['states:StartExecution'],
            effect: Effect.ALLOW,
            resources: [sfArn],
          }),
        ],
      }),
    );
    return gatewayStepFunctionsRole;
  }

  requestModels(rest:IRestApi, postRequest:string) {
    const propertieStr = `{
      "${postRequest}": {
        "type": "${JsonSchemaType.STRING}"
      }
    }`;

    const schemaPost:JsonSchema = {
      title: 'PostRequest',
      type: JsonSchemaType.OBJECT,
      schema: JsonSchemaVersion.DRAFT4,
      properties: JSON.parse(propertieStr),
      required: [postRequest],
    };

    return new Model(this, 'PostModel', {
      restApi: rest,
      contentType: 'application/json',
      schema: schemaPost,
    });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new MyStack(app, 'gateway-sf-text-sentiment-dev', { env: devEnv });
// new MyStack(app, 'gateway-sf-text-sentiment-prod', { env: prodEnv });

app.synth();